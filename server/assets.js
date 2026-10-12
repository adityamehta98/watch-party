'use strict';
// Web page files: read from the public/ folder, or from inside WatchParty.exe when packaged.
const fs = require('fs');
const path = require('path');

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

module.exports = { get, isPackaged: !!sea };
