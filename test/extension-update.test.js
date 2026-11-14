'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { create } = require('../extension/extension-update');
const tick = () => new Promise(resolve => setImmediate(resolve));
function event() { const listeners = []; return { addListener: fn => listeners.push(fn), fire: value => listeners.forEach(fn => fn(value)) }; }
function area() {
  const values = {};
  return { values, get: async key => ({ [key]: values[key] }), set: async data => Object.assign(values, data),
    remove: async key => { delete values[key]; } };
}
function fixture({ status = 'update_available', available = '1.18.0', installType = 'normal', files = '1.18.0', fail = false } = {}) {
  const session = area(), local = area(), timers = [], reloaded = [], requested = [];
  let checks = 0, reloads = 0;
  const api = { storage: { session, local }, management: { getSelf: async () => ({ version: '1.17.9', installType }) },
    runtime: { getURL: file => 'chrome-extension://test/' + file, onUpdateAvailable: event(),
      requestUpdateCheck: async () => { checks++; if (fail) throw new Error('offline'); return { status, version: available }; },
      reload: () => { reloads++; for (const key of Object.keys(session.values)) delete session.values[key]; } },
    tabs: { reload: async id => { reloaded.push(id); if (id === 99) throw new Error('tab closed'); } },
  };
  const options = { later: fn => timers.push(fn), request: async (url, options) => {
    requested.push({ url, options }); return { json: async () => ({ version: files }) };
  } };
  return { api, options, updater: create(api, options), timers, reloaded, requested, local, session,
    checks: () => checks, reloads: () => reloads };
}

test('store update waits for Reload page, survives cleared session storage, and reconnects tabs once', async () => {
  const f = fixture();
  assert.equal((await f.updater.check('1.18.0')).status, 'ready');
  assert.equal(f.checks(), 1);
  assert.equal(f.reloads(), 0, 'checking must not interrupt playback');
  const applied = await Promise.all([f.updater.apply([7, 8, 7, 99, undefined, -1]), f.updater.apply([7])]);
  assert.ok(applied.every(result => result.status === 'reloading'));
  assert.equal(f.timers.length, 1, 'two party windows cannot schedule duplicate extension restarts');
  assert.equal(f.reloads(), 0, 'reply reaches the page before extension restart');
  f.timers[0]();
  assert.equal(f.reloads(), 1);
  assert.deepEqual(f.session.values, {});
  const newWorker = create(f.api, f.options);
  await newWorker.restore();
  assert.deepEqual(f.reloaded, [7, 8, 99]);
  await newWorker.restore();
  assert.deepEqual(f.reloaded, [7, 8, 99], 'closed tabs and repeated worker starts cannot create a reload loop');
  assert.deepEqual(f.local.values, {});
});

test('unavailable, throttled, insufficient and failed updates never claim success or reload', async () => {
  for (const options of [{ status: 'no_update' }, { status: 'throttled' }, { available: '1.17.10' }, { fail: true }]) {
    const f = fixture(options), result = await f.updater.check('1.18.0');
    assert.notEqual(result.status, 'ready');
    assert.equal((await f.updater.apply([7])).status, 'error');
    assert.equal(f.timers.length, 0);
    assert.equal(f.reloads(), 0);
  }
});

test('unpacked updates reload only when the files on disk actually meet the requested version', async () => {
  const host = fixture({ installType: 'development' });
  assert.equal((await host.updater.check('1.18.0')).status, 'ready');
  assert.equal(host.checks(), 0);
  assert.equal(host.requested[0].url, 'chrome-extension://test/manifest.json');
  assert.equal(host.requested[0].options.cache, 'no-store');
  const guest = fixture({ installType: 'development', files: '1.17.9' });
  assert.equal((await guest.updater.check('1.18.0')).status, 'manual');
  assert.equal((await guest.updater.apply([7])).status, 'error');
});

test('passive discovery never downloads a store update or restarts a current extension', async () => {
  const store = fixture();
  assert.equal((await store.updater.check('1.18.0', { passive: true })).status, 'outdated');
  assert.equal(store.checks(), 0);
  assert.equal(store.reloads(), 0);
  assert.equal((await store.updater.check('1.17.9', { passive: true })).status, 'current');
  assert.equal(store.timers.length, 0);
  const managed = fixture({ installType: 'development' });
  assert.equal((await managed.updater.check('1.18.0', { passive: true })).status, 'ready');
  assert.equal(managed.checks(), 0);
});

test('an explicit update click during passive discovery still requests the store download', async () => {
  const f = fixture();
  const passive = f.updater.check('1.18.0', { passive: true });
  const explicit = f.updater.check('1.18.0');
  assert.equal((await passive).status, 'outdated');
  assert.equal((await explicit).status, 'ready');
  assert.equal(f.checks(), 1);
});

test('a downloaded update survives worker sleep and repeated clicks share one check', async () => {
  const f = fixture({ status: 'throttled' });
  f.api.runtime.onUpdateAvailable.fire({ version: '1.18.0' });
  const worker = create(f.api, f.options);
  assert.equal((await worker.check('1.18.0')).status, 'ready');
  assert.equal(f.checks(), 0);
  const other = fixture();
  const results = await Promise.all([other.updater.check('1.18.0'), other.updater.check('1.18.0')]);
  assert.ok(results.every(result => result.status === 'ready'));
  assert.equal(other.checks(), 1);
  assert.equal((await other.updater.check('not-a-version')).status, 'error');
});

test('expired restart markers cannot reload tabs from a later browser session', async () => {
  const f = fixture();
  f.local.values['wp.update.reload'] = { tabs: [7], at: Date.now() - 60000 };
  await f.updater.restore();
  assert.deepEqual(f.reloaded, []);
  assert.deepEqual(f.local.values, {});
});

test('the app offers Update extension then Reload page, with no restart before the second click', async () => {
  const f = fixture(), renders = [];
  const context = vm.createContext({
    S: { movie: { kind: 'service' } }, LATEST_EXT_VERSION: '1.18.0',
    remote: { updateExtension: (op, required) => op === 'check' ? f.updater.check(required) : f.updater.apply([7]) },
    renderServicePanel() { renders.push(JSON.parse(JSON.stringify(context.S.extUpdate))); },
    $: () => null, renderExtensionUpdate() {}, extensionTargetVersion: () => '1.18.0',
    kindOf: m => m.kind, toast() {},
  });
  const app = require('./app-source');
  vm.runInContext(app.slice(app.indexOf('async function updateExtension()'), app.indexOf('function extensionSetupUi()')), context);
  await context.updateExtension();
  assert.equal(context.S.extUpdate.ready, true);
  assert.equal(f.timers.length, 0);
  assert.match(context.S.extUpdate.message, /Reload this page/);
  await context.updateExtension();
  assert.equal(context.S.extUpdate.busy, true);
  assert.equal(f.timers.length, 1);
  assert.deepEqual(renders.map(value => !!value.busy), [true, false, true]);
});

test('the real page bridge and RemoteMedia carry update results, ignoring foreign-window replies', async () => {
  const listeners = [], posted = [], f = fixture();
  const context = vm.createContext({ URL, EventTarget, Event, performance, console, setTimeout, clearTimeout, setInterval() {},
    location: { origin: 'https://party.example' }, document: { readyState: 'complete', querySelector: () => ({}), addEventListener() {} },
    chrome: { runtime: { getManifest: () => ({ version: '1.17.8' }),
      connect: () => ({ onMessage: event(), onDisconnect: event(), postMessage() {} }),
      sendMessage: async m => m.wp === 'extension-update' ? f.updater.check(m.required) : { ok: true, version: '1.17.9', updates: true, verified: true } } },
    window: { addEventListener: (name, fn) => { if (name === 'message') listeners.push(fn); } },
  });
  context.window.postMessage = data => { posted.push(data); for (const fn of listeners) fn({ source: context.window, origin: context.location.origin, data }); };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/party.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/media.js'), 'utf8').replace(/^export /gm, '') + '\nvar remote = new RemoteMedia();', context);
  await tick();
  assert.equal(context.remote.canUpdate, true);
  assert.equal(context.remote.version, '1.17.9', 'the worker version replaces the stale content-script snapshot');
  const result = await context.remote.updateExtension('check', '1.18.0');
  assert.equal(result.status, 'ready');
  assert.equal(f.checks(), 1);
  const original = context.remote.version;
  for (const fn of listeners) fn({ source: {}, origin: context.location.origin, data: { source: 'wp-ext', type: 'hello', version: '99', updates: true } });
  assert.equal(context.remote.version, original);
  for (const fn of listeners) fn({ source: context.window, origin: context.location.origin, data: { source: 'wp-ext', type: 'hello', version: '1.17.1' } });
  assert.equal(context.remote.version, original, 'a stale cached hello cannot downgrade an active worker report');
  for (const fn of listeners) fn({ source: context.window, origin: context.location.origin, data: { source: 'wp-ext', type: 'hello', version: '1.17.8', verified: true } });
  assert.equal(context.remote.version, original, 'an enabled old copy cannot downgrade a newer active copy');
  await tick();
});
