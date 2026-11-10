'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
const latest = require('../extension/manifest.json').version;

function fixture({ version = '1.17.10', status = 'native', movie = null, host = false } = {}) {
  const elements = new Map(), requests = [], notices = [], launches = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { hidden: true, innerHTML: '', open: false, showModal() { this.open = true; }, close() { this.open = false; } });
    return elements.get(id);
  };
  const context = vm.createContext({ URL, EventTarget, Event, console,
    S: { movie, people: [], extPackage: { version: latest, helper: true }, info: { extensionSetup: { canInstall: true } } },
    remote: { present: true, version, canUpdate: true, async updateExtension(op, target, options) {
      requests.push({ op, target, options }); return { status: op === 'apply' ? 'reloading' : status };
    } },
    $: element, stage: { classList: { toggle() {} } }, isHost: host, isTheater: true, isCustom: () => false,
    navigator: { userAgent: 'Windows Chrome' }, kindOf: m => m?.kind, esc: String, PLATFORM: {}, SERVICE_NAMES: { netflix: 'Netflix' },
    toast: (text, options) => notices.push({ text, options }),
    location: { origin: 'https://party.example', set href(value) { launches.push(value); } },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/media.js'), 'utf8').replace(/^export /gm, ''), context);
  vm.runInContext(source.slice(source.indexOf('function serviceName('), source.indexOf('async function onServiceAction(')), context);
  return { context, requests, notices, launches, element };
}

test('compatible older copies show a persistent header update and actionable notice, even on Home', async () => {
  for (const version of ['1.17.8', '1.17.9', '1.17.10', '1.17.11']) {
    const f = fixture({ version });
    await f.context.checkExtensionUpdate();
    assert.equal(f.element('#extensionUpdateBtn').hidden, false);
    assert.match(f.element('#extensionUpdateBtn').title, new RegExp(version.replaceAll('.', '\\.')));
    assert.match(f.notices[0].text, /Extension update available/);
    assert.equal(f.notices[0].options.actions[0].label, 'Update extension');
    assert.equal(f.requests[0].options.passive, true);
    assert.deepEqual(f.launches, [], 'a passive check must not open a native application');
    await f.context.checkExtensionUpdate();
    assert.equal(f.notices.length, 1);
    assert.equal(f.requests.length, 1);
  }
});

test('current and newer versions have no update prompt or restart', async () => {
  for (const version of [latest, '99.0.0']) {
    const f = fixture({ version }); await f.context.checkExtensionUpdate();
    assert.equal(f.element('#extensionUpdateBtn').hidden, true);
    assert.equal(f.requests.length, 0);
    assert.equal(f.notices.length, 0);
  }
});

test('the active latest-version hello hides the button and clears a stale update dialog', async () => {
  const f = fixture(); await f.context.checkExtensionUpdate();
  f.context.S.extUpdate = { ready: true, message: 'Reload page' };
  f.element('#extensionUpdateDialog').open = true;
  f.context.remote.version = latest;
  await f.context.checkExtensionUpdate();
  assert.equal(f.element('#extensionUpdateBtn').hidden, true);
  assert.equal(f.element('#extensionUpdateDialog').open, false);
  assert.equal(f.context.S.extUpdate, null);
  const requests = f.requests.length;
  await f.context.updateExtension();
  assert.equal(f.requests.length, requests, 'an old notification action cannot reinstall the latest version');
});

test('ordinary page reload finishes an update whose files are already installed, only once', async () => {
  const f = fixture({ status: 'ready' });
  await f.context.checkExtensionUpdate();
  assert.deepEqual(f.requests.map(r => r.op), ['check', 'apply']);
  assert.equal(f.requests[1].target, latest);
  await f.context.checkExtensionUpdate();
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.launches, []);
  const refreshed = fixture({ version: latest, status: 'ready' });
  await refreshed.context.checkExtensionUpdate();
  assert.equal(refreshed.requests.length, 0, 'the new page cannot enter an extension reload loop');
});

test('a newer worker hello during a disk check prevents a redundant restart', async () => {
  const f = fixture(); let finish;
  f.context.remote.updateExtension = (op, target) => {
    f.requests.push({ op, target }); return new Promise(resolve => { finish = resolve; });
  };
  const checking = f.context.checkExtensionUpdate();
  f.context.remote.version = latest; finish({ status: 'ready' }); await checking;
  assert.equal(f.requests.length, 1);
});

test('server release metadata exposes updates to an already open older page', async () => {
  const f = fixture({ version: latest }); await f.context.checkExtensionUpdate();
  f.context.fetch = async () => ({ ok: true, json: async () => ({ version: '1.18.0', helper: true }) });
  await f.context.refreshExtensionPackage();
  assert.equal(f.element('#extensionUpdateBtn').hidden, false);
  assert.equal(f.requests.at(-1).target, '1.18.0');
  assert.match(f.notices[0].text, /1\.18\.0/);
});

test('the update dialog and Reload page action stay visible above a theater movie', async () => {
  const f = fixture({ status: 'native', movie: { kind: 'service', service: 'netflix', url: 'https://www.netflix.com/watch/12345' } });
  f.context.key = 'testroom';
  f.context.setTimeout = queueMicrotask;
  f.context.remote.updateExtension = async (op, target) => {
    f.requests.push({ op, target });
    return { status: op === 'apply' ? 'reloading' : f.launches.length ? 'ready' : 'native' };
  };
  await f.context.updateExtension();
  assert.equal(f.element('#extensionUpdateDialog').open, true);
  assert.equal(f.launches.length, 1);
  const uri = new URL(f.launches[0]);
  assert.equal(uri.protocol, 'watchparty-sync:');
  assert.equal(uri.searchParams.get('origin'), 'https://party.example');
  assert.equal(uri.searchParams.get('key'), 'testroom');
  assert.match(f.element('#extensionUpdateBody').innerHTML, /Reload page/);
  assert.doesNotMatch(f.element('#extensionUpdateBody').innerHTML, /Download Windows installer/);
  assert.equal(f.element('#extensionUpdateBtn').textContent, 'Reload to update');
  await f.context.updateExtension();
  assert.deepEqual(f.requests.map(r => r.op), ['check', 'check', 'apply']);
  assert.equal(f.launches.length, 1);
});

test('a copy loaded outside the fixed folder gets installer and migration steps inside the dialog', async () => {
  for (const host of [true, false]) {
    const f = fixture({ status: 'manual', host }); await f.context.updateExtension();
    assert.equal(f.element('#extensionUpdateDialog').open, true);
    const html = f.element('#extensionUpdateBody').innerHTML;
    assert.match(html, /does not move that browser entry/);
    assert.match(html, /SyncExtension/);
    assert.match(html, /Load unpacked/);
    assert.match(html, host ? /Install extension files/ : /Download Windows installer/);
  }
});
