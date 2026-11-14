'use strict';
// Web page files: read from the public/ folder, or from inside WatchParty.exe when packaged.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.zip': 'application/zip',
};

let sea = null;
try { sea = require('node:sea'); if (!sea.isSea()) sea = null; } catch { sea = null; }

const PUBLIC = path.resolve(__dirname, '..', 'public');
const VENDOR = new Map([
  ['vendor/hls.min.js', path.resolve(__dirname, '..', 'node_modules', 'hls.js', 'dist', 'hls.light.min.js')],
  ['vendor/hls.LICENSE.txt', path.resolve(__dirname, '..', 'node_modules', 'hls.js', 'LICENSE')],
]);
const cache = new Map();

function get(rel) {
  rel = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || rel.split('/').some(s => s === '..' || s === '')) return null;
  const type = MIME[path.extname(rel).toLowerCase()] || 'application/octet-stream';
  if (sea) {
    if (cache.has(rel)) return cache.get(rel);
    try {
      const a = { type, body: Buffer.from(sea.getAsset(`public/${rel}`)) };
      cache.set(rel, a);
      return a;
    } catch { return null; }
  }
  try { return { type, body: fs.readFileSync(VENDOR.get(rel) || path.join(PUBLIC, rel)) }; } catch { return null; }
}

// Text files go out gzipped: the page code is about 700 KB raw, and every guest downloads it through the host's upload.
function encoded(asset, acceptEncoding) {
  if (!/^(text\/|application\/json|image\/svg)/.test(asset.type) || !/\bgzip\b/.test(acceptEncoding || '')) return { body: asset.body, headers: {} };
  return { body: asset.gz ||= zlib.gzipSync(asset.body), headers: { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } };
}
// A content tag lets a returning browser skip the download when the file has not changed.
const etag = asset => asset.etag ||= `"${crypto.createHash('sha1').update(asset.body).digest('base64url').slice(0, 20)}"`;

// One tag for the whole page (every file the service worker lists). A tab left open across an update
// compares it when it reconnects and reloads itself; otherwise it keeps running the old page code.
let buildTag = '';
function build() {
  if (buildTag && sea) return buildTag;
  const hash = crypto.createHash('sha1');
  const shell = String(get('sw.js')?.body || '').match(/'\/[^']+'/g) || [];
  for (const rel of ['index.html', ...shell.map(s => s.slice(2, -1))]) hash.update(get(rel)?.body || '');
  return buildTag = hash.digest('base64url').slice(0, 12);
}

module.exports = { get, encoded, etag, build, isPackaged: !!sea };
