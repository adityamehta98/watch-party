'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createExtensionSetup } = require('../server/extension-setup');

function fixture({ platform = 'win32', fail, missing = false } = {}) {
  const root = path.resolve('app'), calls = [];
  const installed = new Set([
    path.join('C:/Users/Viewer/AppData/Local', 'Google/Chrome/Application/chrome.exe'),
    path.join('C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
    path.join('C:/Program Files', 'BraveSoftware/Brave-Browser/Application/brave.exe'),
  ]);
  const setup = createExtensionSetup({ root, platform,
    env: { LOCALAPPDATA: 'C:/Users/Viewer/AppData/Local', ProgramFiles: 'C:/Program Files', 'ProgramFiles(x86)': 'C:/Program Files (x86)', SystemRoot: 'C:/Windows' },
    files: {
      readFileSync(file) { assert.equal(file, path.join(root, 'extension/manifest.json')); if (missing) throw new Error('missing'); return '{"version":"1.17.8"}'; },
      statSync(file) { if (!installed.has(file)) throw new Error('not found'); return { isFile: () => true }; },
    },
    launch(executable, args, options) {
      calls.push({ executable, args, options });
      const child = new EventEmitter(); child.unref = () => {};
      queueMicrotask(() => fail && executable.includes(fail) ? child.emit('error', new Error('launch failed')) : child.emit('spawn'));
      return child;
    },
  });
  return { setup, calls, root };
}

test('native setup opens only the extension folder, never a separate browser profile', async () => {
  for (const browser of ['chrome', 'edge', 'brave']) {
    const f = fixture();
    assert.deepEqual(f.setup.info().browsers, ['chrome', 'edge', 'brave']);
    assert.equal(f.setup.info().directory, path.join(f.root, 'extension'));
    assert.equal((await f.setup.open({ browser, folder: true })).folderOpened, true);
    assert.equal(f.calls.length, 1);
    assert.equal(path.basename(f.calls[0].executable), 'explorer.exe');
    assert.deepEqual(f.calls[0].args, [path.join(f.root, 'extension')]);
    assert.equal(f.calls[0].options.shell, undefined);
    assert.equal(f.calls[0].options.windowsHide, true);
    const update = fixture();
    await assert.rejects(update.setup.open({ browser }), /current browser/);
    assert.equal(update.calls.length, 0);
  }
});

test('setup cannot launch a page-supplied executable, shell command or unsupported installation', async () => {
  const f = fixture();
  for (const browser of ['powershell', 'chrome & calc', 'C:/untrusted/browser.exe', '__proto__', '', null]) {
    await assert.rejects(f.setup.open({ browser }), /current browser/);
  }
  assert.equal(f.calls.length, 0);
  const missing = fixture({ missing: true });
  assert.equal(missing.setup.info(), null);
  await assert.rejects(missing.setup.open({ browser: 'chrome' }), /bundled extension is missing/);
  const other = fixture({ platform: 'darwin' });
  assert.deepEqual(other.setup.info().browsers, []);
  await assert.rejects(other.setup.open({ browser: 'chrome' }), /manually/);
  assert.equal(missing.calls.length + other.calls.length, 0);
});

test('setup keeps a copyable folder fallback when Explorer fails', async () => {
  const f = fixture({ fail: 'explorer.exe' });
  const result = await f.setup.open({ browser: 'chrome', folder: true });
  assert.equal(result.ok, true);
  assert.equal(result.folderOpened, false);
});

function panel({ host = true, version, brave = false, browserFound = true, update, access } = {}) {
  const element = { innerHTML: '' };
  const context = vm.createContext({
    S: { movie: { kind: 'service', service: 'netflix', title: 'Netflix', url: 'https://www.netflix.com/browse' }, extUpdate: update, people: [], extPackage: { helper: true },
      info: { extensionDir: 'C:/Watch Party/app/extension', extensionSetup: { canInstall: true, managedDirectory: 'C:/Users/Viewer/AppData/Local/WatchParty/SyncExtension', browsers: browserFound ? ['chrome', 'edge', 'brave'] : [] } } },
    $: () => element, stage: { classList: { toggle() {} } },
    SERVICE_NAMES: { netflix: 'Netflix' }, remote: { present: !!version, version, access },
    navigator: { userAgent: 'Windows Chrome', brave: brave ? {} : undefined }, isHost: host, isTheater: false, isCustom: () => false,
    PLATFORM: {}, kindOf: m => m.kind, esc: value => String(value),
    refreshInfoSoon() {}, EventTarget, Event, URL,
  });
  const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/media.js'), 'utf8').replace(/^export /gm, ''), context);
  vm.runInContext(source.slice(source.indexOf('function serviceName('), source.indexOf("$('#servicePanel').addEventListener")), context);
  context.renderServicePanel();
  return element.innerHTML;
}

test('host and guest setup show the fixed user folder, precise browser steps and download recovery', () => {
  const install = panel();
  assert.match(install, /Install extension files/);
  assert.match(install, /href="\/ext\/watch-party-sync.zip"/);
  assert.match(install, /AppData\/Local\/WatchParty\/SyncExtension/);
  const update = panel({ version: '1.0.0' });
  assert.match(update, /Update extension/);
  assert.doesNotMatch(update, /Developer mode|Load unpacked|Open extension settings/);
  assert.match(update, /href="\/ext\/watch-party-sync.zip"/);
  const fallback = panel({ version: '1.0.0', update: { manual: true } });
  assert.match(fallback, /Load unpacked/);
  assert.match(fallback, /Download extension ZIP/);
  assert.match(fallback, /data-svc="extension-install"/);
  assert.match(panel({ host: false, version: '1.17.9', update: { manual: true } }), /href="\/ext\/WatchPartyExtensionSetup.exe"/);
  assert.match(panel({ version: '1.0.0', update: { ready: true, message: 'The update is ready.' } }), /Reload page/);
  const manual = panel({ brave: true, browserFound: false });
  assert.match(manual, /brave:\/\/extensions/);
  assert.doesNotMatch(manual, /data-svc="extension-settings"/);
  const guest = panel({ host: false });
  assert.match(guest, /href="\/ext\/watch-party-sync.zip"/);
  assert.doesNotMatch(guest, /C:\/Watch Party/);
  assert.match(guest, /Download Windows installer/);
  assert.match(guest, /%LOCALAPPDATA%/);
  for (const version of ['1.17.8', '1.17.9', '1.17.10']) {
    const current = panel({ version });
    assert.doesNotMatch(current, /Your extension is old|development copy needs/);
    assert.match(current, /Open Netflix in its own tab/);
  }
  const restricted = panel({ version: '1.17.10', access: { service: 'netflix', allowed: false, origin: 'https://www.netflix.com' } });
  assert.match(restricted, /needs site access/);
  assert.doesNotMatch(restricted, /Your extension is old/);
});
