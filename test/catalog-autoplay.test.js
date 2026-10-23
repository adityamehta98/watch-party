'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Room } = require('../server/room');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

function element(attrs = {}, text = '') {
  return { attrs, textContent: text, disabled: false, clicks: 0, children: [],
    closest() { return null; },
    getAttribute(key) { return this.attrs[key] || null; }, getBoundingClientRect: () => ({ width: 200, height: 100 }),
    querySelectorAll() { return this.children; }, click() { this.clicks++; this.onClick?.(); } };
}
async function fixture({ service = 'netflix', title = "India's Got Latent", storage = new Map(), session = new Map() } = {}) {
  let tick, now = 1000, gate = false;
  const links = [], dialogs = [], controls = [], headings = [], events = {}, saved = session, videos = [], metadata = [], reports = [];
  const hostname = service === 'netflix' ? 'www.netflix.com' : 'www.primevideo.com';
  const search = service === 'netflix' ? `https://${hostname}/search?q=${encodeURIComponent(title)}` : `https://${hostname}/search?phrase=${encodeURIComponent(title)}`;
  const location = new URL(search), window = { addEventListener(type, fn) { events['window:' + type] = fn; },
    postMessage(message) { if (videos[0] && !window.blockNative) { if (message.op === 'seek') videos[0].currentTime = message.t; if (message.op === 'play') videos[0].paused = false; } } }; window.top = window;
  location.assign = url => { location.href = url; };
  const request = { id: 'launch1', title, service, url: search };
  const document = {
    addEventListener(type, fn) { events[type] = fn; }, querySelector: () => gate ? {} : null,
    querySelectorAll(selector) {
      if (selector.startsWith('a[href], [role="link"]')) return links;
      if (selector.startsWith('input[type="password"]')) return gate === true ? [element()] : gate ? [gate] : [];
      if (selector.startsWith('[role="dialog"]')) return dialogs;
      if (selector.startsWith('h1,')) return headings;
      if (selector === 'video') return videos;
      if (selector.startsWith('[data-uia="video-title"]')) return metadata;
      return controls;
    },
  };
  const context = vm.createContext({ window, location, document, URL, Date: { now: () => now },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    sessionStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
    setInterval(fn) { tick = fn; }, chrome: { storage: { local: {
      get: async key => ({ [key]: storage.get(key) }), set: async data => { for (const [key, value] of Object.entries(data)) storage.set(key, JSON.parse(JSON.stringify(value))); },
    } }, runtime: { sendMessage: async message => { if (message.wp === 'catalog-launch') return { ...request }; reports.push(message); return {}; } } },
  });
  vm.runInContext(read('extension/services.js'), context);
  vm.runInContext(read('extension/playback-history.js'), context);
  vm.runInContext(read('extension/catalog-launch.js'), context);
  await settle();
  return { links, dialogs, controls, headings, request, location, events, saved, storage, videos, metadata, reports, window, context,
    set gate(value) { gate = value; },
    async tick(ms = 1000) { now += ms; await tick(); },
    details(playLabel = 'Resume episode 3') {
      const heading = element({ alt: title }), play = element({}, playLabel);
      const dialog = element();
      dialog.querySelectorAll = selector => selector.startsWith('h1,') ? [heading] : [play];
      dialogs.push(dialog);
      return play;
    },
  };
}

test('catalog launch selects the exact title, then its native Resume, preserving the service timestamp', async () => {
  const f = await fixture(), unrelated = element({ href: '/title/111', 'aria-label': 'The Great Indian Kapil Show' });
  const match = element({ href: '/title/222', 'aria-label': 'India’s Got Latent' });
  f.links.push(unrelated, match);
  const resume = f.details();
  let servicePosition = 360;
  resume.onClick = () => { f.location.pathname = '/watch/333'; /* Netflix restores its own saved position. */ };
  await f.tick();
  assert.equal(match.clicks, 1);
  assert.equal(unrelated.clicks, 0);
  await f.tick();
  assert.equal(resume.clicks, 1);
  assert.equal(servicePosition, 360);
  assert.equal(f.location.pathname, '/watch/333');
  await f.tick();
  assert.equal(resume.clicks, 1, 'do not repeatedly press Play/Resume');
});

test('ambiguous titles, missing matches, and unrelated searches are never auto-selected', async () => {
  const f = await fixture();
  const first = element({ href: '/title/1', 'aria-label': "India's Got Latent" });
  const second = element({ href: '/title/2', 'aria-label': "India's Got Latent" });
  f.links.push(first, second);
  await f.tick();
  assert.equal(first.clicks + second.clicks, 0);
  f.links.pop();
  f.location.search = '?q=Something+else';
  await f.tick();
  assert.equal(first.clicks, 0);
});

test('sign-in and profile gates pause the launch; selecting a profile does not cancel it', async () => {
  const f = await fixture();
  const match = element({ href: '/title/2', 'aria-label': "India's Got Latent" });
  f.links.push(match);
  f.gate = true;
  f.events.pointerdown({ isTrusted: true, target: { closest: () => ({}) } });
  await f.tick(90000);
  assert.equal(match.clicks, 0);
  f.gate = false;
  await f.tick();
  assert.equal(match.clicks, 1);
});

test('manual title selection cancels pending automation and a fresh launch can retry', async () => {
  const f = await fixture();
  const match = element({ href: '/title/2', 'aria-label': "India's Got Latent" });
  f.links.push(match);
  f.events.pointerdown({ isTrusted: true, target: { closest: () => ({}) } });
  await f.tick();
  assert.equal(match.clicks, 0);
  f.request.id = 'launch2';
  await f.tick();
  assert.equal(match.clicks, 1);
});

test('native Resume is preferred over Play; trailers and purchase controls are not activated', async () => {
  const f = await fixture({ service: 'prime', title: 'A Movie' });
  const link = element({ href: '/detail/film', 'aria-label': 'A Movie' });
  f.links.push(link);
  const resume = f.details('Resume');
  const play = element({}, 'Play'), buy = element({}, 'Watch now: buy'), trailer = element({}, 'Play trailer');
  f.dialogs[0].querySelectorAll = selector => selector.startsWith('h1,') ? [element({alt:'A Movie'})] : [trailer, buy, play, resume];
  await f.tick(); await f.tick();
  assert.equal(resume.clicks, 1);
  assert.equal(play.clicks + buy.clicks + trailer.clicks, 0);
});

test('catalog launch intent survives room confirmation, renews on re-pick, and clears on playback', t => {
  const room = new Room({ config: { adminKey: 'admin-secret', roomKey: 'guestsecretkey1234', room: {} }, library: {} });
  t.after(() => room.shutdown());
  const host = { admitted: true, role: 'host', name: 'Host' };
  const opts = { browsing: true, title: "India's Got Latent", launchTitle: "India's Got Latent" };
  room.selectUrl(host, 'https://www.netflix.com/search?q=Latent', false, opts);
  const initial = room.publicMovie();
  assert.equal(initial.launchTitle, opts.title);
  assert.ok(initial.launchId);
  room.selectUrl(host, initial.url, false, opts);
  assert.notEqual(room.publicMovie().launchId, initial.launchId);
  room.selectUrl(host, 'https://www.netflix.com/watch/333', false, { follow: true, position: 360, playing: true });
  assert.equal(room.publicMovie().launchTitle, '');
  assert.equal(room.state.position, 360, 'room adopts the position restored by Netflix');
  assert.equal(room.state.playing, true);
});

test('Netflix detail links on the search URL are selected automatically', async () => {
  const f = await fixture();
  const link = element({ href: '/search?q=Latent&jbv=222', 'aria-label': "India's Got Latent" });
  f.links.push(link);
  const resume = f.details();
  await f.tick(); await f.tick();
  assert.equal(link.clicks, 1);
  assert.equal(resume.clicks, 1);
});

test('hidden login inputs do not block title launch on a signed-in results page', async () => {
  const f = await fixture();
  const hidden = element(); hidden.getBoundingClientRect = () => ({ width: 0, height: 0 });
  f.gate = hidden;
  const card = element({ role: 'link', 'aria-label': "India's Got Latent" });
  f.links.push(card);
  await f.tick();
  assert.equal(card.clicks, 1, 'an accessible Netflix card does not need an href');
});

test('different Netflix cards without hrefs remain ambiguous instead of sharing a fake /null URL', async () => {
  const f = await fixture();
  const cards = [element({role:'link','aria-label':"India's Got Latent"}), element({role:'link','aria-label':"India's Got Latent"})];
  f.links.push(...cards);
  await f.tick();
  assert.equal(cards.reduce((sum, card) => sum + card.clicks, 0), 0);
});

test('card title metadata outside the link is recognized and native Resume takes priority', async () => {
  const f = await fixture(), card = element({}, "India's Got Latent");
  const info = element({role:'link'}, ''), play = element({'aria-label':'Play'}, ''), resume = element({'aria-label':'Resume'}, '');
  for (const control of [info, play, resume]) { control.closest = () => card; f.links.push(control); }
  await f.tick();
  assert.equal(resume.clicks, 1);
  assert.equal(play.clicks + info.clicks, 0);
});

test('a party that reconnects before theater registration can launch without any linked video', async () => {
  const event = () => { const listeners=[]; return { addListener(fn) { listeners.push(fn); }, fire(...args) { return listeners.map(fn=>fn(...args)); } }; };
  const runtimeConnect=event(), runtimeMessage=event(), partyMessage=event();
  const context=vm.createContext({ URL, URLSearchParams, console, self:{}, importScripts(){}, setTimeout, clearTimeout, chrome:{
    runtime:{id:'ext',onConnect:runtimeConnect,onMessage:runtimeMessage,getURL:p=>`chrome-extension://ext/${p}`},
    sidePanel:{setPanelBehavior:async()=>{}},
    tabs:{onRemoved:event(),onCreated:event(),query:async()=>[],get:async()=>({}),update:async()=>({}),sendMessage:async()=>{}},
    webNavigation:{onDOMContentLoaded:event(),onCreatedNavigationTarget:event(),getAllFrames:async()=>[]},
    scripting:{executeScript:async()=>{}},
    declarativeNetRequest:{getSessionRules:async()=>[],updateSessionRules:async()=>{}},
  }});
  for (const file of ['extension/services.js','extension/ad-domains.js','extension/background.js']) vm.runInContext(read(file),context);
  runtimeConnect.fire({name:'party',sender:{tab:{id:7,windowId:1},frameId:1},onMessage:partyMessage,onDisconnect:event(),postMessage(){}});
  partyMessage.fire({type:'watch',service:'netflix',url:'https://www.netflix.com/search?q=Latent',launchTitle:"India's Got Latent",launchId:'pick1'});
  runtimeMessage.fire({wp:'theater-hello',party:'http://127.0.0.1:8765/host/test'}, {tab:{id:7}},()=>{});
  await settle();
  let request;
  runtimeMessage.fire({wp:'catalog-launch'}, {tab:{id:7},frameId:2,url:'https://www.netflix.com/search?q=Latent'}, value=>{request=value;});
  assert.equal(request?.title,"India's Got Latent");
  assert.equal(request?.id,'pick1');
  let unrelated='unset';
  runtimeMessage.fire({wp:'catalog-launch'}, {tab:{id:8},frameId:0,url:'https://www.netflix.com/search?q=Latent'}, value=>{unrelated=value;});
  assert.equal(unrelated,null,'a normal unrelated Netflix tab cannot claim this launch');
});

function video(position = 0, paused = false) {
  return Object.assign(element(), { readyState: 4, duration: 1800, currentTime: position, paused, seeking: false,
    play() { this.paused = false; return Promise.resolve(); } });
}
async function openPlayer(f, label = 'Play', position = 0, paused = false) {
  const link = element({ href: '/title/222', 'aria-label': f.request.title });
  f.links.push(link);
  const play = f.details(label);
  play.onClick = () => { f.location.pathname = '/watch/333'; f.location.search = ''; };
  await f.tick(); await f.tick();
  const v = video(position, paused); f.videos.push(v);
  f.metadata.push(element({}, f.request.title + ' · S2:E3'));
  return v;
}
test('fresh Play starts at zero, verifies playback, and stores show, episode and actual progress', async () => {
  const f = await fixture(), v = await openPlayer(f, 'Play', 120);
  await f.tick(); await f.tick(1500); await f.tick();
  assert.equal(v.currentTime, 0);
  assert.equal(f.window.__wpCatalogRestoring, false);
  v.currentTime = 321;
  f.events.pause(); await settle();
  const entries = [...f.storage.values()][0].entries;
  assert.equal(entries['333'].showId, '222');
  assert.equal(entries['333'].season, 2); assert.equal(entries['333'].episode, 3);
  assert.equal(entries['333'].position, 321); assert.equal(entries['333'].duration, 1800);
  assert.ok(entries['333'].lastWatched > 0);
});
test('native Resume imports existing account progress when there is no local history', async () => {
  const f = await fixture(), v = await openPlayer(f, 'Resume episode 3', 360);
  await f.tick(); await f.tick(1500);
  assert.equal(v.currentTime, 360);
  await settle();
  assert.equal([...f.storage.values()][0].entries['333'].position, 360);
});
test('saved title and exact episode resume at the stored timestamp after a complete restart', async () => {
  const first = await fixture(), v = await openPlayer(first, 'Play', 0);
  await first.tick(); await first.tick(1500);
  v.currentTime = 654; first.events['window:pagehide'](); await settle();
  const f = await fixture({ storage: first.storage });
  await f.tick();
  assert.equal(f.location.pathname, '/watch/333', 'uses the stored provider episode, not a search guess');
  const resumed = video(0, true); f.videos.push(resumed);
  await f.tick(); await f.tick(1500); await f.tick(); await f.tick();
  assert.equal(resumed.currentTime, 654); assert.equal(resumed.paused, false);
  assert.equal(f.window.__wpCatalogRestoring, false);
});
test('a failed native seek never overwrites saved progress and never repeatedly seeks', async () => {
  const f = await fixture(), key = f.context.WPPlayback.key('netflix', f.request.title);
  f.storage.set(key, { entries: { 333: { assetId:'333',showId:'222',url:'https://www.netflix.com/watch/333',position:777,duration:1800,lastWatched:1 } } });
  f.request.id = 'retry'; await f.tick();
  f.videos.push(video()); f.window.blockNative = true;
  await f.tick(); await f.tick(1500); await f.tick(13000);
  assert.equal(f.storage.get(key).entries['333'].position, 777);
  assert.match(f.reports[0].error, /did not restore/);
  assert.equal(f.window.__wpCatalogRestoring, false);
});
test('a service redirect to a different episode cannot receive the saved timestamp', async () => {
  const f = await fixture(), key = f.context.WPPlayback.key('netflix', f.request.title);
  f.storage.set(key, { entries: { 333: { assetId:'333',url:'https://www.netflix.com/watch/333',position:777,duration:1800,lastWatched:1 } } });
  f.request.id = 'retry'; await f.tick(); f.location.pathname = '/watch/444';
  const v = video(); f.videos.push(v); await f.tick();
  assert.equal(v.currentTime, 0); assert.match(f.reports[0].error, /different episode/);
  assert.equal(f.storage.get(key).entries['333'].position, 777);
});
test('blocked autoplay reports once, keeps progress, and recovers after a manual Play click', async () => {
  const f = await fixture(), v = await openPlayer(f, 'Play', 0, true); f.window.blockNative = true;
  await f.tick(); await f.tick(1500); await f.tick(9000); await f.tick(9000);
  assert.equal(f.reports.length, 1); assert.match(f.reports[0].error, /needs a click/);
  assert.equal(f.storage.size, 0);
  f.events.pointerdown({ isTrusted:true, target:{ closest:()=>null } });
  v.paused = false; await f.tick(); await settle();
  assert.equal(f.window.__wpCatalogRestoring, false); assert.equal(f.storage.size, 1);
});
test('metadata distinguishes remakes and duplicate links to one provider ID are not ambiguous', async () => {
  const f = await fixture({ title:'A Movie' }); f.request.meta = { tmdbId:42,type:'movie',year:'2024' }; f.request.id = 'meta';
  const wrong = element({href:'/watch/11','aria-label':'A Movie','data-year':'1990'});
  const same = [element({href:'/title/22','aria-label':'A Movie','data-year':'2024'}), element({href:'/title/22?track=1','aria-label':'A Movie','data-year':'2024'})];
  f.links.push(wrong,...same); await f.tick();
  assert.equal(wrong.clicks, 0); assert.equal(same[0].clicks + same[1].clicks, 1);
});
test('storage read errors fail safely and unrelated playback does not enter this show history', async () => {
  const f = await fixture(); f.context.chrome.storage.local.get = async()=>{ throw new Error('unavailable'); }; f.request.id = 'new'; await f.tick();
  assert.match(f.reports[0].error, /could not be read/);
  const other = await fixture(), v = await openPlayer(other); await other.tick(); await other.tick(1500); await settle();
  other.location.pathname = '/watch/999'; other.metadata.splice(0,other.metadata.length,element({},'Unrelated title'));
  v.currentTime = 99; other.events.pause(); await settle();
  assert.equal([...other.storage.values()][0].entries['999'], undefined);
});

test('progress continues for the verified player while the party reconnects', async()=>{
  const f=await fixture(),v=await openPlayer(f);await f.tick();await f.tick(1500);await settle();
  f.request.id='';v.currentTime=888;await f.tick(6000);await settle();
  assert.equal([...f.storage.values()][0].entries['333'].position,888);
});
