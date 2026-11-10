'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const core = require('../server/extension-install');
const { archiveDirectory } = require('../build/build-extensions');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-extension-install-'));
  t.after(() => { assert.ok(root.startsWith(path.join(os.tmpdir(), 'wp-extension-install-'))); fs.rmSync(root, { recursive: true, force: true }); });
  const loc = core.locations(path.join(root, 'LocalAppData')), source = path.join(root, 'watch-party-sync');
  fs.cpSync(path.resolve(__dirname, '../extension'), source, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
  const pack = (version = '1.17.10', changes = {}) => {
    fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({ ...manifest, version, ...changes }));
    const zip = path.join(root, 'update.zip'); archiveDirectory(root, 'watch-party-sync', zip); return fs.readFileSync(zip);
  };
  return { loc, pack, source, root };
}

test('all updates keep the fixed per-user directory, replace files, remove old files and preserve browser history', t => {
  const f = fixture(t), first = f.pack();
  assert.equal(f.loc.directory, path.join(f.root, 'LocalAppData', 'WatchParty', 'SyncExtension'));
  assert.equal(core.install(first, { loc: f.loc }).consentRequired, true);
  assert.equal(fs.existsSync(f.loc.directory), false, 'no files are installed before consent');
  core.install(first, { loc: f.loc, permitChanges: true });
  fs.writeFileSync(path.join(f.loc.directory, 'old-release-only.js'), 'obsolete');
  const browserData = path.join(f.root, 'browser-profile-history.json'); fs.writeFileSync(browserData, 'saved playback');
  const result = core.install(f.pack('1.17.11'), { loc: f.loc });
  assert.equal(result.directory, f.loc.directory);
  assert.equal(result.version, '1.17.11');
  assert.equal(fs.existsSync(path.join(f.loc.directory, 'old-release-only.js')), false);
  assert.equal(fs.readFileSync(browserData, 'utf8'), 'saved playback');
  assert.deepEqual(fs.readdirSync(f.loc.home), ['SyncExtension']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.loc.directory, 'watch-party-managed.json'), 'utf8')).schema, 1);
});

test('permission expansion and downgrades cannot silently replace an installed extension', t => {
  const f = fixture(t); core.install(f.pack(), { loc: f.loc, permitChanges: true });
  const before = fs.readFileSync(path.join(f.loc.directory, 'manifest.json'));
  const next = f.pack('1.17.11', { permissions: ['storage', 'cookies'] });
  assert.deepEqual(core.install(next, { loc: f.loc }).added, ['cookies']);
  assert.deepEqual(fs.readFileSync(path.join(f.loc.directory, 'manifest.json')), before);
  assert.throws(() => core.install(f.pack('1.17.9'), { loc: f.loc }), /older extension/);
});

test('a failed directory switch rolls back, and an existing lock cannot be stolen', t => {
  const f = fixture(t); core.install(f.pack(), { loc: f.loc, permitChanges: true });
  const next = f.pack('1.17.11'), original = fs.renameSync;
  fs.renameSync = (from, to) => { if (path.basename(from).startsWith('SyncExtension.next-')) throw new Error('file locked'); return original(from, to); };
  try { assert.throws(() => core.install(next, { loc: f.loc }), /file locked/); } finally { fs.renameSync = original; }
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.loc.directory, 'manifest.json'), 'utf8')).version, '1.17.10');
  assert.deepEqual(fs.readdirSync(f.loc.home), ['SyncExtension']);
  const lock = path.join(f.loc.home, 'extension-update.lock'); fs.writeFileSync(lock, 'owned by another process');
  assert.throws(() => core.install(next, { loc: f.loc }), /EEXIST/);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'owned by another process');
});

test('an interrupted update recovers its old managed directory and dead process lock', t => {
  const f = fixture(t); core.install(f.pack(), { loc: f.loc, permitChanges: true });
  const backup = path.join(f.loc.home, 'SyncExtension.old-123-abcdef123456');
  fs.renameSync(f.loc.directory, backup);
  fs.writeFileSync(path.join(f.loc.home, 'extension-update.lock'), JSON.stringify({ pid: 2147483647 }));
  core.recover(f.loc);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.loc.directory, 'manifest.json'), 'utf8')).version, '1.17.10');
  assert.equal(fs.existsSync(backup), false);
  core.install(f.pack('1.17.11'), { loc: f.loc });
  assert.deepEqual(fs.readdirSync(f.loc.home), ['SyncExtension']);
});

test('an unrelated existing folder cannot be overwritten by installer consent', t => {
  const f = fixture(t); fs.mkdirSync(f.loc.directory, { recursive: true });
  const keep = path.join(f.loc.directory, 'notes.txt'); fs.writeFileSync(keep, 'user data');
  assert.throws(() => core.install(f.pack(), { loc: f.loc, permitChanges: true }), /unrelated files/);
  assert.equal(fs.readFileSync(keep, 'utf8'), 'user data');
});

test('archive traversal, corrupted data and installation junctions are rejected before writing', t => {
  const f = fixture(t), bytes = f.pack(), bad = Buffer.from(bytes);
  for (let at = bad.indexOf('background.js'); at >= 0; at = bad.indexOf('background.js', at + 13)) bad.write('../escape_.js', at);
  assert.throws(() => core.install(bad, { loc: f.loc, permitChanges: true }), /filename/);
  assert.equal(fs.existsSync(f.loc.directory), false);
  const corrupt = Buffer.from(bytes); corrupt[100] ^= 0xff;
  assert.throws(() => core.unpack(corrupt));
  fs.mkdirSync(f.loc.home, { recursive: true });
  const elsewhere = path.join(f.root, 'elsewhere'); fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, f.loc.directory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => core.install(bytes, { loc: f.loc, permitChanges: true }), /junction or symlink/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test('native downloads stay on an approved origin, check SHA-256 and retain no party key in state', async t => {
  const f = fixture(t), bytes = f.pack(), calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    return url.endsWith('/extension/update-info')
      ? Response.json({ version: '1.17.10', sha256: crypto.createHash('sha256').update(bytes).digest('hex') })
      : new Response(bytes);
  };
  assert.deepEqual(await core.download('https://party.example', 'guestkey123', { request }), bytes);
  assert.ok(calls.every(call => call.options.redirect === 'error' && call.options.headers.Cookie === 'wp_k=guestkey123'));
  for (const url of ['http://party.example', 'https://user:secret@party.example', 'https://party.example/other']) await assert.rejects(core.download(url, '', { request }));
  await assert.rejects(core.download('https://party.example', '', { request: async url => url.endsWith('update-info') ? Response.json({ version: '1.17.10', sha256: '0'.repeat(64) }) : new Response(bytes) }), /integrity/);
  core.saveState(f.loc, { installed: true, autoUpdate: true, origins: ['https://party.example'] });
  assert.doesNotMatch(fs.readFileSync(f.loc.state, 'utf8'), /guestkey123/);
  assert.deepEqual(core.readState(f.loc).origins, ['https://party.example']);
});

test('installer consent precedes all writes, source approval is remembered, and later updates need no install prompts', async t => {
  const { main } = require('../server/extension-helper');
  const f = fixture(t), registrations = [], folders = [], prompts = [];
  let accepted = false, version = '1.17.10', downloads = 0;
  const options = { loc: f.loc, platform: 'win32', executable: 'installer.exe', archive: () => f.pack(version),
    confirm(text, question) { prompts.push(text); return question ? accepted : true; },
    registerHelper: (...args) => registrations.push(args), openFolder: dir => folders.push(dir),
    fetchUpdate: async () => { downloads++; return f.pack(version); },
  };
  assert.equal((await main(options)).cancelled, true);
  assert.equal(fs.existsSync(f.loc.home), false);
  accepted = true;
  await main(options);
  assert.equal(registrations.length, 1);
  assert.deepEqual(folders, [f.loc.directory]);
  assert.match(prompts.at(-1), /Load unpacked/);
  const uri = 'watchparty-sync://update?origin=https%3A%2F%2Fparty.example&key=guestkey';
  accepted = false;
  assert.equal((await main({ ...options, uri })).cancelled, true);
  assert.equal(downloads, 0);
  accepted = true; version = '1.17.11';
  await main({ ...options, uri });
  const promptCount = prompts.length;
  version = '1.17.12';
  await main({ ...options, uri });
  assert.equal(prompts.length, promptCount, 'an approved source with unchanged permissions updates without new installer prompts');
  assert.equal(registrations.length, 1);
  assert.equal(core.readState(f.loc).version, '1.17.12');
  assert.doesNotMatch(fs.readFileSync(f.loc.state, 'utf8'), /guestkey/);
});

test('a managed browser copy detects native updates and becomes reload-ready after files are replaced', async t => {
  const f = fixture(t); core.install(f.pack(), { loc: f.loc, permitChanges: true });
  const values = {}, storage = { get: async key => ({ [key]: values[key] }), set: async data => Object.assign(values, data), remove: async key => { delete values[key]; } };
  const { create } = require('../extension/extension-update');
  const updater = create({ storage: { session: storage, local: storage }, management: { getSelf: async () => ({ version: '1.17.10', installType: 'development' }) },
    runtime: { getURL: file => 'chrome-extension://managed/' + file, requestUpdateCheck() { throw new Error('unpacked copies do not use the store'); } } }, {
    request: async url => { const file = path.join(f.loc.directory, new URL(url).pathname.slice(1)); return { ok: true, json: async () => JSON.parse(fs.readFileSync(file, 'utf8')) }; },
  });
  assert.equal((await updater.check('1.17.11')).status, 'native');
  core.install(f.pack('1.17.11'), { loc: f.loc });
  const result = await updater.check('1.17.11');
  assert.equal(result.status, 'ready');
  assert.equal(result.version, '1.17.11');
  assert.equal(f.loc.directory, path.join(f.root, 'LocalAppData', 'WatchParty', 'SyncExtension'));
});
