'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const anime = require('../server/anime');

function envelope(file) {
  const key = Buffer.alloc(32);
  Buffer.from('i?LMTAx0Q6,:}50U').copy(key);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, Buffer.from("W0;27ToaUpl_P%'c"));
  return Buffer.concat([cipher.update(JSON.stringify({ file })), cipher.final()]).toString('base64url');
}

test('MegaPlay source envelopes retain CDN video, captions and skip metadata', () => {
  const parsed = anime.parseSource({ enc: envelope('https://cdn.example/anime/master.m3u8'),
    tracks: [{ file: 'https://cdn.example/en.vtt', label: 'English', kind: 'captions' }],
    intro: { start: 4, end: 90 }, outro: { start: 1300, end: 1400 } }, 'megaplay.buzz');
  assert.equal(parsed.url, 'https://cdn.example/anime/master.m3u8');
  assert.equal(parsed.subtitles[0].label, 'English');
  assert.deepEqual(parsed.intro, { start: 4, end: 90 });
  assert.deepEqual(parsed.outro, { start: 1300, end: 1400 });
  assert.equal(anime.parseSource({ enc: 'invalid-envelope' }, 'megaplay.buzz'), null);
});

test('native anime resolves the exact MegaPlay episode to its own CDN without a second video proxy', async () => {
  const requests = [];
  const result = await anime.resolveStream(114121, 41094, 1, 'dub', { fetcher: async (url, options) => {
    requests.push({ url, options });
    if (requests.length === 1) return { ok: true, text: async () => '<div id="megaplay-player" data-id="97561" data-realid="71353"></div>' };
    return { ok: true, json: async () => ({ enc: envelope('https://cdn.example/master.m3u8'), tracks: [] }) };
  } });
  assert.equal(requests[0].url, 'https://megaplay.buzz/stream/ani/114121/1/dub');
  assert.equal(requests[1].url, 'https://megaplay.buzz/stream/getSourcesNew?id=97561');
  assert.equal(requests[1].options.headers.Referer, requests[0].url);
  assert.equal(result.url, 'https://cdn.example/master.m3u8');
  assert.equal(result.referer, 'https://megaplay.buzz/');
  assert.equal(requests.some(request => request.url.includes('megavid.buzz')), false);
});

test('source resolution tries the MAL mapping when AniList cannot resolve an episode', async () => {
  const requests = [];
  const result = await anime.resolveStream(114121, 41094, 2, 'sub', { fetcher: async url => {
    requests.push(url);
    if (url.includes('/ani/')) return { ok: false };
    if (url.includes('/mal/')) return { ok: true, text: async () => "<div data-id='123' id='megaplay-player'></div>" };
    return { ok: true, json: async () => ({ sources: [{ file: 'https://cdn.example/sub.m3u8' }] }) };
  } });
  assert.equal(requests[1], 'https://megaplay.buzz/stream/mal/41094/2/sub');
  assert.equal(result.url, 'https://cdn.example/sub.m3u8');
});

test('MegaPlay CDN proxy uses the accepted server headers and preserves byte ranges', async () => {
  const requests = [], module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../server/anime.js'), 'utf8'), {
    module, Buffer, URL, AbortSignal,
    require: name => name === './upstream' ? { fetchPublic: async (url, options) => { requests.push({ url, options }); return { ok: true }; } } : name === 'dns' ? { promises: { lookup: async () => [{ address: '203.0.113.10' }] } } : require(name),
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true }; },
  });
  await module.exports.fetchUpstream('https://cdn.example/segment.ts', 'https://megaplay.buzz/', { Range: 'bytes=0-1023' });
  assert.equal(requests[0].options.headers.Referer, 'https://megaplay.buzz/');
  assert.equal(requests[0].options.headers.Range, 'bytes=0-1023');
  assert.equal(requests[0].options.headers.Origin, undefined, 'the extra Origin triggered CDN 403 responses');
  assert.equal(requests[0].options.headers['User-Agent'], undefined, 'the CDN rejects the spoofed browser fingerprint');
});
