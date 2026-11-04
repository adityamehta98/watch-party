'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function helpers() {
  const context = vm.createContext({ URL, self: {} });
  for (const file of ['services.js', 'playback-history.js']) vm.runInContext(read('extension/' + file), context);
  return context;
}

function event() {
  const listeners = [];
  return { addListener(fn) { listeners.push(fn); }, fire(...args) { for (const fn of listeners) fn(...args); }, listeners };
}

async function background({ recovered = [], safari = false, tabUrl = 'chrome-extension://audit/theater.html' } = {}) {
  let rules = recovered;
  const runtimeMessage = event(), connect = event(), before = event(), committed = event();
  const chrome = {
    runtime: { id: 'audit', getURL: file => 'chrome-extension://audit/' + file, onMessage: runtimeMessage, onConnect: connect, sendMessage: async () => {} },
    sidePanel: { setPanelBehavior: async () => {} },
    tabs: { onRemoved: event(), onCreated: event(), query: async () => [], get: async id => ({ id, url: tabUrl }),
      update: async (id, changes) => ({ id, ...changes }), sendMessage: async () => {} },
    webNavigation: { onBeforeNavigate: before, onCommitted: committed, onDOMContentLoaded: event(), onErrorOccurred: event(),
      onCreatedNavigationTarget: event(), getAllFrames: async () => [] },
    declarativeNetRequest: { getSessionRules: async () => recovered,
      updateSessionRules: async ({ removeRuleIds, addRules }) => { rules = [...rules.filter(r => !removeRuleIds.includes(r.id)), ...addRules]; } },
  };
  const context = vm.createContext({ chrome, URL, URLSearchParams, console, setTimeout() {}, self: { WP_SAFARI: safari } });
  context.importScripts = (...files) => { for (const file of files) vm.runInContext(read('extension/' + file), context); };
  vm.runInContext(read('extension/background.js'), context);
  await tick(); await tick();
  const sender = { id: 'audit', frameId: 0, url: 'chrome-extension://audit/theater.html', tab: { id: 7, windowId: 1 } };
  const send = async (message, from = sender) => {
    let result;
    runtimeMessage.fire(message, from, value => { result = value; });
    await tick(); await tick();
    return result;
  };
  return { context, sender, send, connect, before, committed, rules: () => rules,
    controlled: () => vm.runInContext('partyControlsTab(7)', context) };
}

test('playback URLs redact account credentials, sign-in parameters and fragments before sharing', () => {
  const h = helpers();
  assert.equal(h.wpSharedPageUrl('https://user:password@www.netflix.com/login?code=secret&state=private#token'), 'https://www.netflix.com/login');
  assert.equal(h.wpSharedPageUrl('https://www.youtube.com/watch?v=video-id&access_token=secret#private'), 'https://www.youtube.com/watch?v=video-id');
  assert.equal(h.wpSharedPageUrl('https://custom.example/watch?ep=3&token=private&code=private#private'), 'https://custom.example/watch?ep=3');
  assert.equal(h.wpSharedPageUrl('javascript:alert(1)'), '');
});

test('custom-site ad domains tolerate reinjection after background recovery', () => {
  const context = vm.createContext({ self: {} });
  vm.runInContext(read('extension/ad-domains.js'), context);
  const count = context.self.WP_AD_DOMAINS.length;
  vm.runInContext(read('extension/ad-domains.js'), context);
  assert.equal(context.self.WP_AD_DOMAINS.length, count);
  assert.ok(context.self.WP_AD_DOMAINS.includes('doubleclick.net'));
});

test('progress rewrites old URL tokens and persists only playback fields', async () => {
  const h = helpers(), old = { assetId: '123', url: 'https://www.netflix.com/watch/123?token=private#private',
    position: 35, duration: 100, lastWatched: 10, cookie: 'private', catalog: { type: 'tv', tmdbId: 3, year: 2020, token: 'private' } };
  let stored;
  const history = new h.WPPlayback.History({ get: async () => ({ history: { entries: { 123: old } } }), set: async data => { stored = data; } }, 'history', 'netflix');
  const loaded = await history.load();
  assert.equal(loaded.url, 'https://www.netflix.com/watch/123');
  assert.equal(loaded.cookie, undefined);
  assert.equal(loaded.catalog.token, undefined);
  await history.record(loaded);
  assert.equal(JSON.stringify(stored).includes('private'), false);
});

test('only the extension theater can establish header exceptions', async () => {
  const f = await background();
  await f.send({ wp: 'theater-hello', party: 'https://party.example/join/room' }, { ...f.sender, url: 'https://untrusted.example/join/room' });
  assert.equal(f.rules().length, 0);
  assert.equal(f.controlled(), false);
  assert.equal((await f.send({ wp: 'theater-hello', party: 'https://party.example/join/room' })).ok, true);
  assert.equal(f.rules().length, 1);
  assert.equal((await f.send({ wp: 'frame-allow', party: 'https://party.example/join/room', url: 'https://custom.example/watch?ep=3' })).ok, true);
  assert.equal(f.rules().length, 3);
  assert.ok(f.rules().every(rule => rule.condition.tabIds.length === 1 && rule.condition.tabIds[0] === 7));
});

test('top-level navigation revokes theater rules and script ownership', async () => {
  const f = await background();
  await f.send({ wp: 'theater-hello', party: 'https://party.example/join/room', custom: 'https://custom.example/watch' });
  assert.equal(f.controlled(), true);
  f.before.fire({ tabId: 7, frameId: 1, url: 'https://player.example/embed' });
  assert.equal(f.controlled(), true);
  f.before.fire({ tabId: 7, frameId: 0, url: 'https://unrelated.example/' });
  await tick();
  assert.equal(f.controlled(), false);
  assert.equal(f.rules().length, 0);
});

test('worker recovery drops stale frame rules for a tab that left the theater', async () => {
  const f = await background({ recovered: [{ id: 1, condition: { tabIds: [7] } }], tabUrl: 'https://unrelated.example/' });
  assert.equal(f.controlled(), false);
  assert.equal(f.rules().length, 0);
});

test('Safari custom playback keeps link navigation but revokes typed addresses', async () => {
  const f = await background({ safari: true, recovered: [{ id: 1, condition: { tabIds: [7] } }, { id: 2, condition: { tabIds: [7] } }], tabUrl: 'https://custom.example/watch' });
  assert.equal(f.controlled(), true);
  f.committed.fire({ tabId: 7, frameId: 0, url: 'https://custom.example/episode2', transitionType: 'link' });
  assert.equal(f.controlled(), true);
  f.committed.fire({ tabId: 7, frameId: 0, url: 'https://unrelated.example/', transitionType: 'typed' });
  await tick();
  assert.equal(f.controlled(), false);
  assert.equal(f.rules().length, 0);
});

test('party ports and theater-open reject unrelated documents and credentialed URLs', async () => {
  const f = await background();
  let disconnected = false;
  f.connect.fire({ name: 'party', sender: { ...f.sender, url: 'https://other.example/page' }, disconnect() { disconnected = true; } });
  assert.equal(disconnected, true);
  const from = { ...f.sender, url: 'https://party.example/join/room' };
  assert.equal((await f.send({ wp: 'theater-open', url: 'https://other.example/join/room' }, from)).ok, false);
  assert.equal((await f.send({ wp: 'theater-open', url: 'https://user:secret@party.example/join/room' }, from)).ok, false);
  assert.equal(f.rules().length, 0);
});

test('redirected party frames cannot control the extension theater', async () => {
  const elements = new Map(), messages = [], listeners = {};
  const element = id => {
    if (!elements.has(id)) elements.set(id, { hidden: true, style: {}, src: '', contentWindow: {}, textContent: '',
      addEventListener() {}, removeAttribute() {} });
    return elements.get(id);
  };
  const context = vm.createContext({ URL, URLSearchParams, Map, Date, console, setInterval() {}, clearTimeout() {},
    location: { hash: '#p=https%3A%2F%2Fparty.example%2Fjoin%2Froom' }, document: { getElementById: element },
    window: { addEventListener(type, fn) { listeners[type] = fn; } },
    chrome: { tabs: { getCurrent: async () => ({ id: 7 }) }, runtime: { id: 'audit', onMessage: { addListener() {} },
      sendMessage: async message => { messages.push(message); return { ok: true }; } } },
  });
  vm.runInContext(read('extension/services.js'), context);
  vm.runInContext(read('extension/theater.js'), context);
  const stage = { source: element('party').contentWindow, origin: 'https://untrusted.example',
    data: { wpTheater: 'stage', show: true, custom: true, url: 'https://custom.example/watch' } };
  listeners.message(stage);
  await tick();
  assert.equal(element('svc').src, '');
  assert.equal(messages.some(m => m.wp === 'frame-allow'), false);
  listeners.message({ ...stage, origin: 'https://party.example' });
  await tick();
  assert.equal(element('svc').src, 'https://custom.example/watch');
});
