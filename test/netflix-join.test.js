'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

// Two independent service documents execute the production content script and MAIN bridge.
// The fixture models Netflix's SPA/profile lifecycle; it does not claim to exercise Netflix DRM.
function screen({ gate = false, pathname = '/watch/12345', nativeLink = false } = {}) {
  let now = 1000, pin = gate, hardLoads = 0, navigationCount = 0, routerWorks = true;
  const intervals = [], messages = [], incoming = [], events = new Map();
  const location = new URL('https://www.netflix.com' + pathname);
  location.assign = () => { hardLoads++; pin = true; };
  const video = { readyState: 4, duration: 7200, currentTime: 480, paused: false, playbackRate: 1, volume: 1, muted: false,
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
  window.addEventListener('popstate', route);
  const context = vm.createContext({ window, location, URL, console, Map, Set,
    Date: { now: () => now }, performance: { now: () => now },
    setInterval: (fn, ms) => { intervals.push({ fn, ms, last: now }); }, setTimeout() {}, clearTimeout() {},
    getComputedStyle: () => ({ visibility: 'visible' }),
    PopStateEvent: class { constructor(type, value) { this.type = type; Object.assign(this, value); } },
    history: { state: {}, pushState(state, _, url) { this.state = state; location.pathname = url; } },
    document: {
      title: 'Test movie - Netflix', addEventListener() {},
      querySelector(selector) { if (selector === 'video') return pin ? null : video; return null; },
      querySelectorAll(selector) {
        if (selector === 'video') return pin ? [] : [video];
        if (selector.startsWith('input[')) return pin ? [{ getClientRects: () => [1] }] : [];
        if (selector === 'a[href]' && nativeLink) return [{ href: 'https://www.netflix.com/watch/12345', click() { location.pathname = '/watch/12345'; route(); } }];
        return [];
      },
    },
    chrome: { runtime: { id: 'test-extension', onMessage: { addListener: fn => incoming.push(fn) }, sendMessage: async message => { messages.push(message); } } },
  });
  for (const name of ['services', 'service-navigation', 'netflix-main']) vm.runInContext(read(`extension/${name}.js`), context);
  vm.runInContext(read('extension/service.js').split('// ------------------------------------------------ the party\'s buttons')[0], context);
  return { context, location, messages, video,
    get hardLoads() { return hardLoads; }, get navigations() { return navigationCount; },
    set routerWorks(value) { routerWorks = value; },
    tick(ms = 1000) {
      for (let elapsed = 0; elapsed < ms; elapsed += 250) {
        now += 250;
        for (const timer of intervals) if (now - timer.last >= timer.ms) { timer.last = now; timer.fn(); }
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
