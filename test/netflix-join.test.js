'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Room } = require('../server/room');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8').replace(/\r\n/g, '\n');

// Two independent service documents execute the production content script and MAIN bridge.
// The fixture models Netflix's SPA/profile lifecycle; it does not claim to exercise Netflix DRM.
function screen({ gate = false, pathname = '/watch/12345', nativeLink = false, spinner = false, paused = false, epoch = 1000, embedded = false, cachedGates = [] } = {}) {
  let now = epoch, pin = gate, hardLoads = 0, navigationCount = 0, routerWorks = true, observer = () => {};
  let timerId = 0;
  const timeouts = new Map();
  const intervals = [], messages = [], incoming = [], events = new Map();
  const location = new URL('https://www.netflix.com' + pathname);
  location.assign = () => { hardLoads++; pin = true; };
  const video = { readyState: 4, duration: 7200, currentTime: 480, paused, playbackRate: 1, volume: 1, muted: false,
    getBoundingClientRect: () => ({ width: 1200, height: 700 }), addEventListener() {}, removeEventListener() {},
    play: async () => { video.paused = false; }, pause: () => { video.paused = true; } };
  const route = () => { navigationCount++; if (!routerWorks) location.pathname = '/browse'; };
  const window = {
    addEventListener(name, fn) { if (!events.has(name)) events.set(name, []); events.get(name).push(fn); },
    dispatchEvent(event) { for (const fn of events.get(event.type) || []) fn(event); },
    postMessage(data) { window.dispatchEvent({ type: 'message', source: window, origin: location.origin, data }); },
    netflix: { appContext: { state: { playerApp: { getAPI: () => ({ videoPlayer: {
      getAllPlayerSessionIds: () => ['session'], getVideoPlayerBySessionId: () => ({
        seek: milliseconds => { video.currentTime = milliseconds / 1000; }, play: video.play, pause: video.pause,
      }),
    } }) } } } },
  };
  window.top = window;
  if (embedded) { window.top = {}; location.ancestorOrigins = ['chrome-extension://test-extension']; }
  window.addEventListener('popstate', route);
  const context = vm.createContext({ window, location, URL, console, Map, Set,
    Date: { now: () => now }, performance: { now: () => now },
    EventTarget, Event,
    setInterval: (fn, ms) => { intervals.push({ fn, ms, last: now }); }, clearInterval() {},
    setTimeout: (fn, ms = 0) => { timeouts.set(++timerId, { fn, at: now + ms }); return timerId; }, clearTimeout: id => timeouts.delete(id),
    getComputedStyle: node => node.css || { visibility: 'visible' },
    PopStateEvent: class { constructor(type, value) { this.type = type; Object.assign(this, value); } },
    history: { state: {}, pushState(state, _, url) { this.state = state; location.pathname = url; } },
    document: {
      title: 'Test movie - Netflix', addEventListener() {},
      querySelector(selector) {
        if (selector === 'video') return pin ? null : video;
        if (selector === '[data-uia="video-title"]') return { textContent: 'Akka · E1 The Sisterhood' };
        return null;
      },
      querySelectorAll(selector) {
        if (selector === 'video') return pin ? [] : [video];
        if (selector.startsWith('input[')) {
          const nodes = pin ? [{ getClientRects: () => [1] }] : [];
          // Substring matching "pin" also matches the data-uia value "loading-spinner".
          if (spinner && selector.includes('[data-uia*="pin" i]')) nodes.push({ getClientRects: () => [1] });
          return nodes.concat(cachedGates);
        }
        if (selector === 'a[href]' && nativeLink) return [{ href: 'https://www.netflix.com/watch/12345', click() { location.pathname = '/watch/12345'; route(); } }];
        return [];
      },
    },
    chrome: { runtime: { id: 'test-extension', onMessage: { addListener: fn => incoming.push(fn) }, sendMessage: async message => { messages.push(message); observer(message); } } },
  });
  for (const name of ['services', 'service-navigation', 'netflix-main']) vm.runInContext(read(`extension/${name}.js`), context);
  vm.runInContext(read('extension/service.js').split('// ------------------------------------------------ the party\'s buttons')[0], context);
  return { context, location, messages, video,
    get now() { return now; },
    onSend(fn) { observer = fn; },
    fromExtension(message) { window.postMessage({ source: 'wp-ext', ...message }); },
    get hardLoads() { return hardLoads; }, get navigations() { return navigationCount; },
    set routerWorks(value) { routerWorks = value; },
    tick(ms = 1000) {
      for (let elapsed = 0; elapsed < ms; elapsed += 250) {
        now += 250;
        for (const timer of intervals) if (now - timer.last >= timer.ms) { timer.last = now; timer.fn(); }
        for (const [id, timer] of timeouts) if (now >= timer.at) { timeouts.delete(id); timer.fn(); }
      }
    },
    command(cmd) { for (const listener of incoming) listener({ wp: 'cmd', cmd }, { id: 'test-extension' }, () => {}); },
    navigate(url, sender = 'test-extension') { for (const listener of incoming) listener({ wp: 'navigate', url }, { id: sender }, () => {}); },
    unlock(destination = '/browse') { pin = false; location.pathname = destination; },
  };
}

for (const pinPath of ['/watch/12345', '/profiles', '/browse']) {
  for (const loginDelay of [2000, 10000, 60000]) {
    for (const nativeLink of [false, true]) test(`host playing; guest PIN at ${pinPath}, ${loginDelay}ms delay, native link ${nativeLink}`, () => {
      const host = screen(), guest = screen({ gate: true, pathname: pinPath, nativeLink });
      host.tick();
      const hostStatus = host.messages.find(message => message.wp === 'status').st;
      guest.navigate(hostStatus.url);
      guest.tick(loginDelay);
      assert.equal(guest.navigations, 0, 'never navigate while a password/PIN gate is visible');
      assert.equal(guest.messages.some(message => message.wp === 'status'), false, 'PIN URLs do not count as loaded playback');
      guest.unlock(); // Netflix lands on Home after profile unlock.
      guest.tick(3000);
      assert.equal(guest.location.pathname, '/watch/12345');
      assert.equal(guest.navigations, 1);
      assert.equal(guest.hardLoads, 0, 'the unlocked profile document stays alive');
      guest.command({ op: 'seek', t: hostStatus.t });
      guest.command({ op: 'play' });
      assert.equal(guest.video.currentTime, host.video.currentTime);
      assert.equal(guest.video.paused, false);
      guest.tick(60000);
      assert.equal(guest.navigations, 1, 'no delayed recovery loop sends the guest back to PIN');
      assert.equal(guest.location.pathname, '/watch/12345');
    });
  }
}

test('a title changed during PIN entry replaces the queued destination', () => {
  const guest = screen({ gate: true });
  guest.navigate('https://www.netflix.com/watch/12345'); guest.tick(5000);
  guest.navigate('https://www.netflix.com/watch/98765'); guest.tick(5000);
  guest.unlock(); guest.tick(3000);
  assert.equal(guest.location.pathname, '/watch/98765');
  assert.equal(guest.hardLoads, 0);
});

test('a loading spinner cannot suppress the host title and status as a false PIN gate', () => {
  const host = screen({ spinner: true, paused: true, embedded: true }); host.tick(2000);
  assert.ok(host.messages.some(message => message.wp === 'status'), 'loaded playback must still be reported');
  assert.equal(host.messages.find(message => message.wp === 'page').signin, false);
});

for (const css of [{ opacity: '0' }, { visibility: 'hidden' }, { display: 'none' }]) {
  test(`an invisible cached PIN form does not suppress loaded playback: ${JSON.stringify(css)}`, () => {
    const host = screen({ paused: true, cachedGates: [{ getClientRects: () => [1], css }] }); host.tick(2000);
    assert.ok(host.messages.some(message => message.wp === 'status'));
    assert.equal(host.messages.find(message => message.wp === 'page').signin, false);
  });
}

function roomFlow(t, { paused, spinner, embedded }) {
  const epoch = Date.now(), host = screen({ paused, spinner, embedded, epoch }), guest = screen({ gate: true, embedded, epoch });
  const room = new Room({ config: { roomKey: 'testroomsecret1234', room: { autoWait: false } }, library: {} });
  t.after(() => room.shutdown());
  const participants = [], selections = [], navigationRequests = [], held = new Set();
  const background = vm.createContext({ URL, Date, console, parties: participants, rebindDocks() {},
    post: (port, message) => port.postMessage(message) });
  vm.runInContext(read('extension/services.js'), background);
  const bg = read('extension/background.js');
  vm.runInContext(bg.slice(bg.indexOf('function link('), bg.indexOf('function unlink(')), background);
  const routeStart = bg.indexOf('  for (const party of parties) {', bg.indexOf('const tabId = sender.tab.id, frameId'));
  const routeEnd = bg.indexOf('\n});\n\nchrome.tabs.onRemoved', routeStart);
  vm.runInContext(`function report(m, sender) { const tabId = sender.tab.id, frameId = sender.frameId || 0; ${bg.slice(routeStart, routeEnd)} }`, background);
  const app = read('public/js/app.js');
  const follow = app.slice(app.indexOf('let followTimer ='), app.indexOf("window.addEventListener('message', e => {", app.indexOf('let followTimer =')));
  const keep = app.slice(app.indexOf('let keepOffSince ='), app.indexOf('// top bar camera', app.indexOf('let keepOffSince =')));
  for (const [index, page] of [host, guest].entries()) {
    const context = page.context;
    const party = { watch: { service: 'netflix' }, pendingTab: index + 1, link: null, port: { postMessage: message => page.fromExtension(message) } };
    participants.push(party);
    const client = { id: index ? 'guestclient' : 'hostclient', name: index ? 'Guest' : 'Host', role: index ? 'guest' : 'host', admitted: true,
      perms: { playback: true }, ws: { readyState: 1, send(raw) {
        const message = JSON.parse(raw);
        if (message.type === 'movie') { context.S.movie = message.movie; context.player.setMovie(message.movie); }
        if (message.type === 'state') { context.S.state = message.state; context.player.setState(message.state); }
      } } };
    room.clients.set(client.id, client);
    Object.assign(context, { isHost: !index, isTheater: embedded, isCustom: () => false, kindOf: movie => movie?.kind, serviceName: () => 'Netflix',
      S: { movie: null, state: null }, reachedTitle: false, PLATFORM: { device: 'desktop' }, toast() {},
      theaterPost: message => { if (message.wpTheater === 'goto') { navigationRequests.push(message.url); page.navigate(message.url); } },
      conn: { send(message) { if (message.type === 'select-url') selections.push({ index, message }); room.onMessage(client, message); } },
    });
    vm.runInContext(read('public/js/media.js').replace(/^export /gm, '') + '\nglobalThis.remote = new RemoteMedia({ onInfo() {} });', context);
    vm.runInContext(read('public/js/sync.js').replace(/^export /gm, ''), context);
    vm.runInContext(read('public/js/player.js').replace(/^import .*;$/gm, '').replace(/^export /gm, '') +
      '\nglobalThis.player = new SyncPlayer({ video: remote, clock: { synced: true, now: Date.now, rtt: 0 }, onStatus() {} });', context);
    vm.runInContext(follow + '\n' + keep, context);
    context.window.addEventListener('message', event => {
      const message = event.data;
      if (message?.source === 'wp-ext' && message.type === 'status') context.maybeFollowTab();
      if (message?.source !== 'wp-page') return;
      if (message.type === 'watch') party.watch = message;
      if (message.type === 'cmd') page.command(message.cmd);
      if (message.type === 'navigate') { navigationRequests.push(message.url); page.navigate(message.url); }
    });
    page.onSend(message => { if (!held.has(index)) background.report(message, { tab: { id: index + 1, windowId: index + 1 }, frameId: embedded ? 2 : 0 }); });
    context.remote.present = true;
  }
  room.selectUrl(room.clients.get('hostclient'), 'https://www.netflix.com/browse', true, { browsing: true });
  return { room, host, guest, selections, navigationRequests,
    holdHostReports(value) { if (value) held.add(0); else held.delete(0); },
    tick(ms) { for (let at = 0; at < ms; at += 250) { host.tick(250); guest.tick(250); } } };
}

test('a transient host status loss retries publication instead of remaining in browse mode forever', t => {
  const flow = roomFlow(t, { paused: true, spinner: false, embedded: true });
  flow.tick(500);
  flow.holdHostReports(true); flow.host.context.remote.st = null;
  flow.tick(2000);
  assert.equal(flow.room.movie.browsing, true);
  flow.holdHostReports(false); flow.tick(3000);
  assert.equal(flow.room.movie.browsing, false);
  assert.equal(flow.room.movie.url, 'https://www.netflix.com/watch/12345');
});

for (const embedded of [false, true]) {
  test(`a playing host publishes its title and the guest catches up after PIN unlock (embedded ${embedded})`, t => {
    const flow = roomFlow(t, { paused: false, spinner: true, embedded });
    flow.tick(4000);
    assert.equal(flow.room.movie.browsing, false);
    assert.equal(flow.room.state.playing, true);
    flow.guest.unlock(); flow.tick(20000);
    assert.equal(flow.guest.location.pathname, '/watch/12345');
    assert.equal(flow.guest.video.paused, false);
    assert.ok(Math.abs(flow.guest.video.currentTime - flow.host.video.currentTime) < 2, 'the sync engine aligns both players');
    assert.equal(flow.guest.hardLoads, 0);
  });
}

for (const embedded of [false, true]) for (const spinner of [false, true]) {
  test(`paused host publishes the title through the room before guest PIN recovery (embedded ${embedded}, spinner ${spinner})`, t => {
    const flow = roomFlow(t, { paused: true, spinner, embedded });
    flow.tick(4000);
    assert.equal(flow.room.movie.browsing, false, 'the room must leave browse mode even if the host pauses while waiting');
    assert.equal(flow.room.movie.url, 'https://www.netflix.com/watch/12345');
    assert.equal(flow.room.movie.title, 'Akka · E1 The Sisterhood');
    assert.equal(flow.room.state.playing, false);
    assert.equal(flow.room.state.position, 480);
    assert.equal(flow.selections[0].index, 0, 'the host supplies the destination through production status routing');
    assert.equal(flow.guest.navigations, 0, 'the guest stays on the PIN gate until it is unlocked');
    flow.guest.unlock(); flow.tick(20000);
    assert.equal(flow.guest.location.pathname, '/watch/12345');
    assert.equal(flow.guest.video.currentTime, 480, 'the production sync engine aligns to the paused host frame');
    assert.equal(flow.guest.video.paused, true);
    assert.equal(flow.guest.hardLoads, 0);
    flow.tick(60000);
    assert.equal(flow.guest.navigations, 1, 'the unlocked Netflix document remains stable');
    assert.equal(flow.room.movie.url, 'https://www.netflix.com/watch/12345');
  });
}
test('Netflix previews are never reported as room playback and foreign navigation is ignored', () => {
  const guest = screen({ pathname: '/browse' }); guest.tick(5000);
  assert.equal(guest.messages.some(message => message.wp === 'status'), false);
  guest.navigate('https://www.netflix.com/watch/12345', 'another-extension');
  guest.navigate('https://evil.example/watch/12345'); guest.tick(5000);
  assert.equal(guest.navigations, 0);
});
test('a failed native route does not repeatedly reload Netflix or reset its PIN session', () => {
  const guest = screen({ pathname: '/browse' }); guest.routerWorks = false;
  guest.navigate('https://www.netflix.com/watch/12345'); guest.tick(3000);
  for (let i = 0; i < 10; i++) { guest.navigate('https://www.netflix.com/watch/12345'); guest.tick(15000); }
  assert.equal(guest.navigations, 1);
  assert.equal(guest.hardLoads, 0);
});

test('guest arrival is confirmed by playable video, not a /watch URL carrying a PIN gate', () => {
  const app = read('public/js/app.js'), start = app.indexOf('let keepOffSince =');
  let tick, now = 1000;
  const moves = [];
  const remote = { present: true, linked: false, pageUrl: 'https://www.netflix.com/watch/12345', signingIn: true, readyState: 0, page: { at: now } };
  const context = vm.createContext({ remote, isHost: false, isTheater: false, S: { movie: { kind: 'service', service: 'netflix', url: remote.pageUrl } },
    kindOf: m => m.kind, canonicalUrl: url => url || '', serviceOfUrl: () => 'netflix', serviceName: () => 'Netflix',
    Date: { now: () => now }, performance: { now: () => now }, setInterval: fn => { tick = fn; }, toast() {},
  });
  remote.navigate = url => moves.push(url);
  vm.runInContext(app.slice(start, app.indexOf('// top bar camera', start)), context);
  tick();
  remote.signingIn = false; remote.pageUrl = 'https://www.netflix.com/browse';
  now = 20000; remote.page.at = now; tick(); now += 3500; remote.page.at = now; tick();
  assert.deepEqual(moves, ['https://www.netflix.com/watch/12345']);
});
