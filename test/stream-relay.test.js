'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { relay } = require('../server/upstream');

const u = new URL('http://x/a?k=key&c=client1');
const reply = (method = 'GET') => ({ req: { method, headers: {} },
  res: { status: 0, headers: null, body: '', writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body = '') { this.body = String(body); } } });
const upstream = text => ({ ok: true, status: 200, url: 'https://cdn.example/a.m3u8', text: async () => text });

test('the media relay rewrites playlists, converts captions and refuses unknown or failed targets', async () => {
  let f = reply();
  await relay(f.req, f.res, u, null);
  assert.equal(f.res.status, 404);
  f = reply();
  await relay(f.req, f.res, u, { kind: 'm3u8' }, { fetch: async () => upstream('#EXTM3U'), rewrite: (text, base, auth) => `${text}|${base}|${auth}` });
  assert.equal(f.res.body, '#EXTM3U|https://cdn.example/a.m3u8|k=key&c=client1');
  assert.equal(f.res.headers['Content-Type'], 'application/vnd.apple.mpegurl');
  f = reply('HEAD');
  await relay(f.req, f.res, u, { kind: 'sub' }, { fetch: async () => upstream('cue'), toVtt: text => `WEBVTT ${text}` });
  assert.equal(f.res.headers['Content-Length'], 10);
  assert.equal(f.res.body, '');
  f = reply();
  await relay(f.req, f.res, u, { kind: 'seg' }, { fetch: async () => ({ ok: false, status: 500 }) });
  assert.equal(f.res.status, 502);
});

test('the media relay streams segments with the viewer\'s byte range and counts what it sends', async () => {
  const res = Object.assign(new PassThrough(), { writeHead(status, headers) { this.status = status; this.headers = headers; } });
  let asked, sent = 0;
  await relay({ method: 'GET', headers: { range: 'bytes=0-5' } }, res, u, { kind: 'seg' }, { onBytes: n => { sent += n; },
    fetch: async extra => { asked = extra.Range; return { ok: false, status: 206, body: new Response('abcdef').body, headers: new Headers({ 'content-type': 'video/mp2t', 'content-range': 'bytes 0-5/6' }) }; } });
  let body = '';
  for await (const chunk of res) body += chunk;
  assert.deepEqual([asked, res.status, res.headers['Content-Range'], res.headers['Content-Type'], body, sent], ['bytes=0-5', 206, 'bytes 0-5/6', 'video/mp2t', 'abcdef', 6]);
});
