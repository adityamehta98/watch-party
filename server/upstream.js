'use strict';

const http = require('http');
const https = require('https');
const dns = require('dns').promises;
const net = require('net');
const zlib = require('zlib');
const { Readable } = require('stream');

// Only globally routable targets are useful to the media proxies. In particular,
// reject IPv4 embedded in IPv6, link-local/ULA, carrier NAT and transition ranges.
function isPublicIp(value) {
  const ip = String(value || '').replace(/^\[|\]$/g, '');
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || b === 0)) || (a === 198 && [18, 19].includes(b)) || a >= 224);
  }
  if (!net.isIPv6(ip) || ip.includes('%')) return false;
  const first = parseInt(ip.split(':')[0], 16), second = parseInt(ip.split(':')[1] || '0', 16);
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 && !(first === 0x2001 && second < 0x0200);
}

async function publicAddresses(url, lookup = dns.lookup) {
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || !host
      || /(?:^|\.)(?:localhost|local|internal)$/i.test(host)) throw new Error('blocked host');
  const addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some(item => !isPublicIp(item.address))) throw new Error('blocked host');
  return addresses.map(item => ({ address: item.address, family: net.isIP(item.address) }));
}

async function boundedText(response, limit = 2 * 1024 * 1024) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel().catch(() => {});
    throw new Error('upstream response too large');
  }
  let size = 0;
  const parts = [];
  if (response.body) for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('upstream response too large');
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts).toString('utf8');
}

// Pin the validated DNS answer into the actual TCP/TLS connection. A separate
// validation followed by fetch() would resolve the name a second time.
function requestOnce(url, headers, addresses, { request, signal }) {
  return new Promise((resolve, reject) => {
    const transport = request || (url.protocol === 'https:' ? https.request : http.request);
    const req = transport(url, {
      headers, signal, agent: false,
      lookup(_host, options, callback) {
        const list = options.family ? addresses.filter(item => item.family === options.family) : addresses;
        if (!list.length) return callback(new Error('blocked host'));
        if (options.all) callback(null, list);
        else callback(null, list[0].address, list[0].family);
      },
    }, incoming => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : String(value));
      }
      let stream = incoming;
      const encoding = responseHeaders.get('content-encoding');
      const decoder = encoding === 'gzip' ? zlib.createGunzip() : encoding === 'deflate' ? zlib.createInflate() : encoding === 'br' ? zlib.createBrotliDecompress() : null;
      if (decoder) {
        incoming.on('error', error => decoder.destroy(error));
        decoder.on('close', () => incoming.destroy());
        stream = incoming.pipe(decoder);
        responseHeaders.delete('content-encoding');
        responseHeaders.delete('content-length');
      }
      const response = { status: incoming.statusCode, ok: incoming.statusCode >= 200 && incoming.statusCode < 300,
        url: url.href, headers: responseHeaders, body: Readable.toWeb(stream) };
      response.text = () => boundedText(response);
      resolve(response);
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchPublic(raw, { headers = {}, lookup, request, timeout = 20000 } = {}) {
  const signal = AbortSignal.timeout(timeout);
  let url;
  try { url = new URL(raw); } catch { throw new Error('bad url'); }
  let nextHeaders = { ...headers };
  for (let redirects = 0; redirects <= 5; redirects++) {
    const addresses = await publicAddresses(url, lookup);
    if (signal.aborted) throw new Error('upstream timeout');
    const response = await requestOnce(url, nextHeaders, addresses, { request, signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    await response.body.cancel().catch(() => {});
    if (!location || redirects === 5) throw new Error('bad redirect');
    const next = new URL(location, url);
    // Custom headers can contain host credentials. They belong to the configured
    // origin, not to arbitrary redirect destinations supplied by an upstream.
    if (next.origin !== url.origin) nextHeaders = Object.fromEntries(Object.entries(nextHeaders)
      .filter(([name]) => /^(?:accept|accept-language|range|user-agent|referer|origin)$/i.test(name)));
    url = next;
  }
  throw new Error('too many redirects');
}

// Hands one upstream HLS resource to a browser: playlists are rewritten to come back through this server,
// captions become WebVTT, and everything else (segments, keys) is streamed with Range support.
async function relay(req, res, u, target, { fetch, rewrite, toVtt, onBytes } = {}) {
  const fail = (code = 404) => { res.writeHead(code, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); return res.end(code === 404 ? 'Not found' : 'Upstream error'); };
  const privately = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
  const sendText = (type, body) => { res.writeHead(200, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...privately }); return req.method === 'HEAD' ? res.end() : res.end(body); };
  if (!target) return fail();
  try {
    if (target.kind === 'm3u8' || target.kind === 'sub') {
      const r = await fetch();
      if (!r.ok) return fail(r.status === 404 ? 404 : 502);
      if (target.kind === 'sub') return sendText('text/vtt; charset=utf-8', toVtt(await r.text()));
      const auth = new URLSearchParams({ k: u.searchParams.get('k') || '' });
      const c = u.searchParams.get('c'); if (c) auth.set('c', c);
      return sendText('application/vnd.apple.mpegurl', rewrite(await r.text(), r.url || target.url, auth.toString()));
    }
    const r = await fetch(req.headers.range ? { Range: req.headers.range } : {});
    if (!(r.ok || r.status === 206)) return fail(r.status === 404 ? 404 : 502);
    const headers = { ...privately, 'Accept-Ranges': 'bytes' };
    for (const name of ['Content-Type', 'Content-Length', 'Content-Range']) { const value = r.headers.get(name); if (value) headers[name] = value; }
    res.writeHead(r.status === 206 ? 206 : 200, headers);
    if (req.method === 'HEAD' || !r.body) { await r.body?.cancel().catch(() => {}); return res.end(); }
    const stream = Readable.fromWeb(r.body);
    if (onBytes) stream.on('data', chunk => onBytes(chunk.length));
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    return stream.pipe(res);
  } catch { return fail(502); }
}

module.exports = { fetchPublic, isPublicIp, boundedText, relay };
