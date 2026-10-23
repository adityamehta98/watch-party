'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function theater() {
  const elements = new Map(), messages = [], listeners = {}, runtime = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { hidden: true, style: {}, src: '', textContent: '', contentWindow: {},
      addEventListener(type, fn) { this[type] = fn; }, removeAttribute() {} });
    return elements.get(id);
  };
  const context = vm.createContext({ URL, URLSearchParams, Map, Date, console, setInterval() {}, clearTimeout() {},
    location: { hash: '#p=http%3A%2F%2F127.0.0.1%3A8765%2Fhost%2Ftest' },
    document: { getElementById: element },
    window: { addEventListener(type, fn) { listeners[type] = fn; } },
    chrome: { tabs: { getCurrent: async () => ({ id: 7 }) }, runtime: { id: 'extension',
      onMessage: { addListener(fn) { runtime.push(fn); } },
      sendMessage(message) { messages.push(message); return context.setup(message); } } },
    setup: async () => ({ ok: true }),
  });
  vm.runInContext(read('extension/services.js'), context);
  vm.runInContext(read('extension/theater.js'), context);
  return { context, element, messages,
    stage(url = 'https://www.netflix.com/search?q=Mashle') {
      listeners.message({ source: element('party').contentWindow, data: {
        wpTheater: 'stage', show: true, url, browsing: true, rect: { x: 0, y: 0, w: 1000, h: 700 },
      } });
    },
    failure(message, sender = { id: 'extension' }) { runtime[0]({ wp: 'theater-frame-error', tabId: 7, url: 'https://www.netflix.com/login', error: 'net::ERR_BLOCKED_BY_RESPONSE', ...message }, sender); },
  };
}

test('embedded service waits for successful setup and reports setup failures without navigating', async () => {
  const f = theater();
  let finish;
  f.context.setup = () => new Promise(resolve => { finish = resolve; });
  f.stage();
  assert.equal(f.element('svc').src, '');
  finish({ ok: false, error: 'Frame setup failed' });
  await tick();
  assert.equal(f.element('svc').src, '');
  assert.equal(f.element('help').hidden, false);
  assert.match(f.element('helpText').textContent, /Frame setup failed/);
  f.context.setup = async () => ({ ok: true });
  f.element('helpRetry').click();
  await tick();
  assert.equal(f.element('svc').src, 'https://www.netflix.com/search?q=Mashle');
  assert.equal(f.element('help').hidden, true);
});

test('late setup responses cannot replace a newly selected embedded service', async () => {
  const f = theater(), pending = [];
  f.context.setup = () => new Promise(resolve => pending.push(resolve));
  f.stage();
  f.stage('https://www.primevideo.com/search?phrase=Movie');
  pending[1]({ ok: true });
  await tick();
  pending[0]({ ok: true });
  await tick();
  assert.equal(f.element('svc').src, 'https://www.primevideo.com/search?phrase=Movie');
});

test('frame errors appear during browsing and retry stays in the same Watch Party frame', async () => {
  const f = theater();
  f.stage();
  await tick();
  f.failure({ tabId: 8 });
  f.failure({}, { id: 'other-extension' });
  assert.equal(f.element('help').hidden, true);
  f.failure({});
  assert.equal(f.element('help').hidden, false);
  assert.match(f.element('helpText').textContent, /ERR_BLOCKED_BY_RESPONSE/);
  f.element('helpRetry').click();
  await tick();
  assert.equal(f.element('svc').src, 'https://www.netflix.com/search?q=Mashle');
  assert.equal(f.messages.at(-1).wp, 'theater-hello');
});

test('service helpers can be injected repeatedly after background reconnection', () => {
  const context = vm.createContext({ self: {} });
  vm.runInContext(read('extension/services.js'), context);
  vm.runInContext(read('extension/services.js'), context);
  assert.equal(context.wpServiceOf('www.netflix.com'), 'netflix');
  assert.ok(context.self.WP_SERVICE_DOMAINS.includes('netflix.com'));
});

test('frame-rule updates serialize, propagate failure and allow a later retry', async () => {
  const source = read('extension/background.js');
  const start = source.indexOf('const FRAME_RULE_ID =');
  const end = source.indexOf('// This background part is put to sleep', start);
  const pending = [];
  const context = vm.createContext({ theaterTabs: new Set([7]), customHosts: new Map(),
    WP_SERVICE_DOMAINS: ['netflix.com'], chrome: { declarativeNetRequest: {
      updateSessionRules: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    } } });
  vm.runInContext(source.slice(start, end), context);
  const first = context.updateFrameRules(), second = context.updateFrameRules();
  const rejected = assert.rejects(first, /setup failed/);
  await tick();
  assert.equal(pending.length, 1);
  pending[0].reject(new Error('setup failed'));
  await rejected;
  await tick();
  assert.equal(pending.length, 2);
  pending[1].resolve();
  await second;
});
