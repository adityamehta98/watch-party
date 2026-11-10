'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { atLeast } = require('../extension/extension-update');

function locations(localAppData = process.env.LOCALAPPDATA) {
  if (!localAppData || !path.isAbsolute(localAppData)) throw new Error('Windows LocalAppData is unavailable.');
  const base = path.resolve(localAppData), home = path.join(base, 'WatchParty');
  return { base, home, directory: path.join(home, 'SyncExtension'), helper: path.join(home, 'ExtensionUpdater.exe'), state: path.join(home, 'extension-updater.json') };
}
function safePath(base, target) {
  const rel = path.relative(base, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Extension path escaped its installation folder.');
  let current = base;
  for (const part of ['', ...rel.split(path.sep)]) {
    if (part) current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Extension installation cannot use a junction or symlink.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function readState(loc) {
  safePath(loc.base, loc.state);
  try { return JSON.parse(fs.readFileSync(loc.state, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
function saveState(loc, state) {
  safePath(loc.base, loc.state);
  fs.mkdirSync(loc.home, { recursive: true });
  const temporary = loc.state + '.tmp';
  safePath(loc.base, temporary);
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
  fs.renameSync(temporary, loc.state);
}
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function unpack(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > 8 * 1024 * 1024) throw new Error('Invalid extension download.');
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50) throw new Error('Invalid ZIP directory.');
  const count = bytes.readUInt16LE(end + 10), directoryEnd = bytes.readUInt32LE(end + 16) + bytes.readUInt32LE(end + 12);
  if (!count || count > 256 || directoryEnd > end || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw new Error('Unsupported extension archive.');
  let offset = bytes.readUInt32LE(end + 16), total = 0;
  const entries = new Map(), names = new Set();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > directoryEnd || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP entry.');
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10), crc = bytes.readUInt32LE(offset + 16);
    const packed = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24), nameLength = bytes.readUInt16LE(offset + 28);
    const next = offset + 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    const mode = (bytes.readUInt32LE(offset + 38) >>> 16) & 0xf000, local = bytes.readUInt32LE(offset + 42);
    if (next > directoryEnd || flags & 1 || ![0, 8].includes(method) || mode === 0xa000 || local + 30 > bytes.length) throw new Error('Unsafe ZIP entry.');
    let name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset = next;
    if (name.startsWith('watch-party-sync/')) name = name.slice(17);
    if (!name || name.endsWith('/')) continue;
    if (name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part))) throw new Error('Unsafe extension filename.');
    if (!/\.(?:js|json|html|css|png|svg|txt)$/i.test(name) && name !== 'LICENSE') throw new Error('Unexpected extension file type.');
    const folded = name.toLowerCase();
    if (names.has(folded) || /(?:^|\/)(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error('Conflicting extension filename.');
    names.add(folded);
    total += size;
    if (total > 16 * 1024 * 1024 || size > 4 * 1024 * 1024) throw new Error('Extension archive is too large.');
    if (bytes.readUInt32LE(local) !== 0x04034b50) throw new Error('Invalid ZIP data.');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (start + packed > directoryEnd) throw new Error('Truncated ZIP data.');
    const encoded = bytes.subarray(start, start + packed), data = method === 8 ? zlib.inflateRawSync(encoded, { maxOutputLength: size || 1 }) : encoded;
    if (data.length !== size || crc32(data) !== crc) throw new Error('Extension download failed its integrity check.');
    entries.set(name, data);
  }
  const manifest = JSON.parse(entries.get('manifest.json')?.toString() || 'null');
  if (!manifest || manifest.name !== 'Watch Party Sync' || manifest.manifest_version !== 3 || !atLeast(manifest.version, '0')) throw new Error('Not a Watch Party Sync extension.');
  const refs = [manifest.background?.service_worker, manifest.side_panel?.default_path, ...Object.values(manifest.icons || {}),
    ...(manifest.content_scripts || []).flatMap(script => [...(script.js || []), ...(script.css || [])])];
  if (refs.some(file => !entries.has(file))) throw new Error('Extension package is missing required files.');
  return { entries, manifest };
}
function permissionSet(manifest) {
  return new Set(['permissions', 'host_permissions', 'optional_permissions', 'optional_host_permissions'].flatMap(key => manifest[key] || [])
    .concat((manifest.content_scripts || []).flatMap(script => script.matches || [])));
}
function acquireLock(loc) {
  fs.mkdirSync(loc.home, { recursive: true });
  const lock = path.join(loc.home, 'extension-update.lock'); safePath(loc.base, lock);
  let handle;
  try { handle = fs.openSync(lock, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner; try { owner = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch { throw error; }
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw error;
    try { process.kill(owner.pid, 0); throw error; }
    catch (probe) { if (probe.code !== 'ESRCH') throw error; }
    fs.unlinkSync(lock); handle = fs.openSync(lock, 'wx');
  }
  fs.writeFileSync(handle, JSON.stringify({ pid: process.pid }));
  return () => { fs.closeSync(handle); fs.unlinkSync(lock); };
}
function recover(loc) {
  safePath(loc.base, loc.directory);
  if (fs.existsSync(loc.directory) || !fs.existsSync(loc.home)) return;
  const release = acquireLock(loc);
  try {
    for (const name of fs.readdirSync(loc.home).filter(name => /^SyncExtension\.old-\d+-[a-f0-9]{12}$/.test(name)).sort().reverse()) {
      const backup = path.join(loc.home, name); safePath(loc.base, backup);
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(backup, 'manifest.json'), 'utf8'));
        const marker = JSON.parse(fs.readFileSync(path.join(backup, 'watch-party-managed.json'), 'utf8'));
        if (manifest.name !== 'Watch Party Sync' || marker.schema !== 1) continue;
      } catch { continue; }
      fs.renameSync(backup, loc.directory); return;
    }
  } finally { release(); }
}
function install(bytes, { loc = locations(), permitChanges = false } = {}) {
  const { entries, manifest } = unpack(bytes);
  safePath(loc.base, loc.directory);
  let previous;
  try { previous = JSON.parse(fs.readFileSync(path.join(loc.directory, 'manifest.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (fs.existsSync(loc.directory) && previous?.name !== 'Watch Party Sync') throw new Error('The fixed extension folder contains unrelated files; it was not changed.');
  if (previous && (previous.key || '') !== (manifest.key || '')) throw new Error('An update cannot change the extension identity.');
  if (previous && !atLeast(manifest.version, previous.version)) throw new Error('An older extension cannot replace your installed version.');
  const added = [...permissionSet(manifest)].filter(value => !permissionSet(previous || {}).has(value));
  if (!permitChanges && (!previous || added.length)) return { consentRequired: true, added, version: manifest.version };
  const release = acquireLock(loc);
  const suffix = process.pid + '-' + crypto.randomBytes(6).toString('hex');
  const stage = path.join(loc.home, 'SyncExtension.next-' + suffix), backup = path.join(loc.home, 'SyncExtension.old-' + suffix);
  let moved = false;
  try {
    safePath(loc.base, stage); safePath(loc.base, backup);
    fs.mkdirSync(stage);
    for (const [name, data] of entries) {
      const file = path.join(stage, ...name.split('/'));
      safePath(stage, file); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data);
    }
    fs.writeFileSync(path.join(stage, 'watch-party-managed.json'), JSON.stringify({ schema: 1 }));
    if (fs.existsSync(loc.directory)) { fs.renameSync(loc.directory, backup); moved = true; }
    try { fs.renameSync(stage, loc.directory); }
    catch (error) { if (moved) fs.renameSync(backup, loc.directory); moved = false; throw error; }
    if (moved) { safePath(loc.base, backup); fs.rmSync(backup, { recursive: true }); }
    return { installed: true, version: manifest.version, directory: loc.directory };
  } finally {
    if (fs.existsSync(stage)) { safePath(loc.base, stage); fs.rmSync(stage, { recursive: true }); }
    release();
  }
}
function originFrom(raw) {
  const url = new URL(raw);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('Updates require a trusted HTTPS party address.');
  return url.origin;
}
async function download(origin, key, { request = fetch } = {}) {
  origin = originFrom(origin);
  if (key && !/^[A-Za-z0-9]+$/.test(key)) throw new Error('Invalid party access key.');
  const options = { redirect: 'error', headers: key ? { Cookie: 'wp_k=' + key } : {}, signal: AbortSignal.timeout(30000) };
  const metadata = await request(origin + '/extension/update-info', options);
  if (!metadata.ok) throw new Error('Open the current party invite and try again.');
  const info = await metadata.json();
  if (!/^[a-f0-9]{64}$/.test(info.sha256) || !atLeast(info.version, '0')) throw new Error('Invalid update metadata.');
  const response = await request(origin + '/ext/watch-party-sync.zip', options);
  if (!response.ok || Number(response.headers.get('content-length')) > 8 * 1024 * 1024) throw new Error('Extension download is unavailable or too large.');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > 8 * 1024 * 1024) throw new Error('Extension download is too large.'); chunks.push(Buffer.from(chunk)); }
  const bytes = Buffer.concat(chunks);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== info.sha256 || unpack(bytes).manifest.version !== info.version) throw new Error('Extension download failed its integrity check.');
  return bytes;
}
module.exports = { locations, safePath, readState, saveState, unpack, install, recover, originFrom, download };
