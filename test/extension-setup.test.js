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

test('setup discovers supported browsers and opens their own settings plus the bundled folder', async () => {
  for (const browser of ['chrome', 'edge', 'brave']) {
    const f = fixture();
    assert.deepEqual(f.setup.info().browsers, ['chrome', 'edge', 'brave']);
    assert.equal(f.setup.info().directory, path.join(f.root, 'extension'));
    assert.equal((await f.setup.open({ browser, folder: true })).folderOpened, true);
    assert.deepEqual(f.calls[0].args, [`${browser}://extensions/`]);
    assert.equal(path.basename(f.calls[0].executable), { chrome: 'chrome.exe', edge: 'msedge.exe', brave: 'brave.exe' }[browser]);
    assert.deepEqual(f.calls[1].args, [path.join(f.root, 'extension')]);
    assert.equal(f.calls[0].options.shell, undefined);
    assert.equal(f.calls[0].options.windowsHide, true);
    const update = fixture();
    await update.setup.open({ browser });
    assert.equal(update.calls.length, 1, 'updates do not reopen Explorer or replace the extension entry');
  }
});

test('setup cannot launch a page-supplied executable, shell command or unsupported installation', async () => {
  const f = fixture();
  for (const browser of ['powershell', 'chrome & calc', 'C:/untrusted/browser.exe', '__proto__', '', null]) {
    await assert.rejects(f.setup.open({ browser }), /not found/);
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

test('setup reports a browser launch failure and keeps a folder fallback when Explorer fails', async () => {
  await assert.rejects(fixture({ fail: 'chrome.exe' }).setup.open({ browser: 'chrome' }), /launch failed/);
  const f = fixture({ fail: 'explorer.exe' });
  const result = await f.setup.open({ browser: 'chrome', folder: true });
  assert.equal(result.ok, true);
  assert.equal(result.folderOpened, false);
});

function panel({ host = true, version, brave = false, browserFound = true, update } = {}) {
  const element = { innerHTML: '' };
  const context = vm.createContext({
    S: { movie: { kind: 'service', service: 'netflix', title: 'Netflix' }, extUpdate: update,
      info: { extensionDir: 'C:/Watch Party/app/extension', extensionSetup: { browsers: browserFound ? ['chrome', 'edge', 'brave'] : [] } } },
    $: () => element, stage: { classList: { toggle() {} } },
    SERVICE_NAMES: { netflix: 'Netflix' }, remote: { present: !!version, version },
    navigator: { userAgent: 'Chrome', brave: brave ? {} : undefined }, isHost: host,
    PLATFORM: {}, kindOf: m => m.kind, esc: value => String(value),
    extOutdated: () => true, refreshInfoSoon() {},
  });
  const source = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('function serviceName('), source.indexOf("$('#servicePanel').addEventListener")), context);
  context.renderServicePanel();
  return element.innerHTML;
}

test('host setup and updates use the bundled folder without a download, with Brave and manual fallbacks', () => {
  const install = panel();
  assert.match(install, /Open extension setup/);
  assert.match(install, /C:\/Watch Party\/app\/extension/);
  assert.doesNotMatch(install, /href="\/ext\//);
  const update = panel({ version: '1.0.0' });
  assert.match(update, /Update extension/);
  assert.doesNotMatch(update, /Developer mode|Load unpacked|Open extension settings/);
  assert.doesNotMatch(update, /href="\/ext\//);
  const fallback = panel({ version: '1.0.0', update: { manual: true } });
  assert.match(fallback, /Open extension settings/);
  assert.match(panel({ version: '1.0.0', update: { ready: true, message: 'The update is ready.' } }), /Reload page/);
  const manual = panel({ brave: true, browserFound: false });
  assert.match(manual, /brave:\/\/extensions/);
  assert.doesNotMatch(manual, /data-svc="extension-setup"/);
  const guest = panel({ host: false });
  assert.match(guest, /href="\/ext\/watch-party-sync.zip"/);
  assert.doesNotMatch(guest, /C:\/Watch Party/);
});
