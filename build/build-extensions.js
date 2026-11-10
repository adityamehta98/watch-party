'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const COMMON = path.join(ROOT, 'extension');
const CHROMIUM_STAGE_ROOT = path.join(ROOT, 'build', 'cache', 'chromium-extension');
const CHROMIUM_STAGE = path.join(CHROMIUM_STAGE_ROOT, 'watch-party-sync');
const CHROMIUM_OUTPUT = path.join(ROOT, 'public', 'ext', 'watch-party-sync.zip');

function assertInside(root, target) {
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`unsafe build path: ${target}`);
}

function archiveDirectory(parent, folderName, output, { includeFolder = true } = {}) {
  const base = path.join(parent, folderName), files = [];
  const visit = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) files.push(file);
      else throw new Error(`unsupported archive entry: ${file}`);
    }
  };
  visit(base);
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
    return n >>> 0;
  });
  const crc32 = data => {
    let crc = 0xffffffff;
    for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
    return (crc ^ 0xffffffff) >>> 0;
  };
  const locals = [], central = [];
  let offset = 0;
  for (const file of files) {
    const data = fs.readFileSync(file), compressed = zlib.deflateRawSync(data, { level: 9 });
    const packed = compressed.length < data.length ? compressed : data, method = packed === compressed ? 8 : 0;
    const name = Buffer.from(`${includeFolder ? folderName + '/' : ''}${path.relative(base, file).split(path.sep).join('/')}`), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0x2821, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(0x800, 8);
    header.writeUInt16LE(method, 10); header.writeUInt16LE(0, 12); header.writeUInt16LE(0x2821, 14);
    header.writeUInt32LE(crc, 16); header.writeUInt32LE(packed.length, 20); header.writeUInt32LE(data.length, 24); header.writeUInt16LE(name.length, 28); header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(output, Buffer.concat([...locals, directory, end]));
}

function versions(root = ROOT) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
  if (!manifest.description || manifest.description.length > 132) throw new Error('extension description must be 1–132 characters');
  const common = manifest.version;
  const media = fs.readFileSync(path.join(root, 'public', 'js', 'media.js'), 'utf8');
  const page = /LATEST_EXT_VERSION = '([^']+)'/.exec(media)?.[1];
  if (!page || common !== page) throw new Error(`extension version mismatch: Chromium ${common}, page ${page || 'missing'}`);
}

function buildStore(root = ROOT) {
  versions(root);
  const output = path.join(root, 'build', 'output', 'extensions', 'watch-party-sync-chrome-store.zip');
  assertInside(root, output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  archiveDirectory(root, 'extension', output, { includeFolder: false });
  return output;
}

function buildChromium() {
  versions();
  for (const target of [CHROMIUM_STAGE_ROOT, CHROMIUM_OUTPUT]) assertInside(ROOT, target);
  fs.rmSync(CHROMIUM_STAGE_ROOT, { recursive: true, force: true });
  fs.rmSync(CHROMIUM_OUTPUT, { force: true });
  fs.mkdirSync(CHROMIUM_STAGE, { recursive: true });
  fs.cpSync(COMMON, CHROMIUM_STAGE, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(CHROMIUM_STAGE, 'LICENSE'));
  fs.mkdirSync(path.dirname(CHROMIUM_OUTPUT), { recursive: true });
  archiveDirectory(CHROMIUM_STAGE_ROOT, 'watch-party-sync', CHROMIUM_OUTPUT);
  fs.rmSync(CHROMIUM_STAGE_ROOT, { recursive: true, force: true });
  return CHROMIUM_OUTPUT;
}

if (require.main === module) console.log('built', process.argv.includes('--store') ? buildStore() : buildChromium());
module.exports = { archiveDirectory, buildChromium, buildStore };
