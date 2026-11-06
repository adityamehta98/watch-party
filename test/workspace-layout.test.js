'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

test('runtime paths distinguish source checkouts, legacy settings and portable executables', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-party-layout-'));
  t.after(() => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'watch-party-layout-'))); fs.rmSync(root, { recursive: true, force: true }); });
  const source = fs.readFileSync(path.join(ROOT, 'server/tools.js'), 'utf8');
  const resolve = packaged => {
    const context = vm.createContext({ require: name => name === 'node:sea' ? { isSea: () => packaged } : require(name), __dirname: path.join(root, 'server'), process: { platform: process.platform, execPath: path.join(root, 'portable', 'WatchParty.exe') }, module: { exports: {} } });
    vm.runInContext(source, context); return context.module.exports;
  };
  assert.equal(resolve(false).ROOT, path.join(root, 'app'));
  put(path.join(root, 'config.json'), '{}');
  assert.equal(resolve(false).ROOT, root, 'legacy source settings remain readable until migration');
  assert.equal(resolve(true).ROOT, path.join(root, 'portable'));
  assert.equal(resolve(true).IS_SEA, true);
});

test('local installation preserves private data, relative paths and repeat installs, refusing conflicts', { skip: process.platform !== 'win32' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-party-layout-'));
  t.after(() => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'watch-party-layout-'))); fs.rmSync(root, { recursive: true, force: true }); });
  const release = path.join(root, 'build/output/WatchParty');
  put(path.join(release, 'WatchParty.exe'), 'new executable');
  put(path.join(release, 'bin/ffmpeg.exe'), 'new tool');
  put(path.join(root, 'WatchParty.exe'), 'old executable');
  const original = JSON.stringify({ adminKey: 'fixture-secret', folders: ['movies'], cacheDir: 'prepared' });
  put(path.join(root, 'config.json'), original);
  put(path.join(root, 'watch-history.json'), '{"resume":360}');
  put(path.join(root, 'cache/subtitles/manual.vtt'), 'saved captions');
  const install = () => spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'build/install-local.ps1'), '-Workspace', root, '-NoLaunch'], { encoding: 'utf8', windowsHide: true });
  let result = install(); assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(root, 'config.json')), false);
  const app = path.join(root, 'app');
  const config = JSON.parse(fs.readFileSync(path.join(app, 'config.json')));
  assert.equal(config.adminKey, 'fixture-secret'); assert.deepEqual(config.folders, [path.join(root, 'movies')]); assert.equal(config.cacheDir, path.join(root, 'prepared'));
  assert.equal(fs.readFileSync(path.join(app, 'cache/migration/config.original.json'), 'utf8'), original);
  assert.equal(fs.readFileSync(path.join(app, 'watch-history.json'), 'utf8'), '{"resume":360}');
  assert.equal(fs.readFileSync(path.join(app, 'cache/subtitles/manual.vtt'), 'utf8'), 'saved captions');
  assert.equal(fs.readFileSync(path.join(app, 'WatchParty.exe'), 'utf8'), 'new executable');
  assert.equal(fs.readFileSync(path.join(app, 'bin/ffmpeg.exe'), 'utf8'), 'new tool');
  const savedConfig = fs.readFileSync(path.join(app, 'config.json'), 'utf8');
  result = install(); assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(app, 'config.json'), 'utf8'), savedConfig);
  put(path.join(root, 'config.json'), '{"other":"do not overwrite"}');
  result = install(); assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(path.join(root, 'config.json'), 'utf8'), '{"other":"do not overwrite"}');
  assert.equal(fs.readFileSync(path.join(app, 'config.json'), 'utf8'), savedConfig);
});
