'use strict';
// Serves files with HTTP byte-range support so browsers can seek instantly in huge movie files.
const fs = require('fs');

const TYPES = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4',
  '.webm': 'video/webm', '.vtt': 'text/vtt; charset=utf-8',
  '.m3u8': 'application/vnd.apple.mpegurl', '.m4s': 'video/iso.segment',
};

function authorizeHlsPlaylist(text, query) {
  const add = uri => uri.includes('?') ? `${uri}&${query}` : `${uri}?${query}`;
  return String(text).split(/\r?\n/).map(line => {
    if (!line) return line;
    if (line[0] !== '#') return add(line);
    return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${add(uri)}"`);
  }).join('\n');
}

function contentTypeFor(file) {
  const m = file.toLowerCase().match(/\.[a-z0-9]+$/);
  return (m && TYPES[m[0]]) || 'application/octet-stream';
}

function serveFile(req, res, file, { onBytes, type, maxChunk = 0 } = {}) {
  let stat;
  try { stat = fs.statSync(file); } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  const size = stat.size;
  const headers = {
    'Content-Type': type || contentTypeFor(file),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  let start = 0, end = size - 1, status = 200;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (m[1] === '' && m[2] === '')) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    if (m[1] === '') { // suffix range: last N bytes
      start = Math.max(0, size - parseInt(m[2], 10));
    } else {
      start = parseInt(m[1], 10);
      if (m[2] !== '') end = Math.min(parseInt(m[2], 10), size - 1);
    }
    if (start >= size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }

    if (maxChunk && end - start + 1 > maxChunk) end = start + maxChunk - 1;
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || size === 0) return res.end();
  const stream = fs.createReadStream(file, { start, end, highWaterMark: 1 << 20 });
  if (onBytes) stream.on('data', chunk => onBytes(chunk.length));
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

module.exports = { serveFile, contentTypeFor, authorizeHlsPlaylist };
