'use strict';
// Anime search + playable stream, with no browser extension (plays in the page on iPad too).
//
// Discovery uses AniList's public GraphQL API (stable, documented). Playback resolves a real HLS
// (.m3u8) stream server-side from MegaPlay's documented JSON source API and proxies it through this
// server, so every viewer plays the SAME native <video>/HLS the movies use. That means:
//   * play / pause / seek stay in sync for everyone (the normal SyncPlayer drives one <video>), and
//   * nobody sees ads — there is no third-party iframe, just the raw video stream.
// The proxy rewrites the playlist so segments, keys and subtitles are fetched back through us (with
// the right Referer, and with ad / private hosts blocked). If resolution fails, room.js falls back
// to MegaPlay's iframe embed (embedSources below), i.e. the previous behaviour.

const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { Readable } = require('stream');

const PRIMARY = 'https://megaplay.buzz';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Signing secret for proxy URLs. Set from the admin key at startup so a guest can't make the server
// fetch an arbitrary URL: every proxied link carries an HMAC of its target that we verify.
let SECRET = 'wp-anime-default';
function init(key) { if (key) SECRET = String(key); }

const mkEmbedUrl = (kind, id, ep, lang) => {
  const i = Math.trunc(Number(id)), n = Math.trunc(Number(ep));
  const l = lang === 'dub' ? 'dub' : 'sub';
  return i > 0 && n > 0 ? `${PRIMARY}/stream/${kind}/${i}/${n}/${l}` : null;
};

// Ordered iframe-embed candidates (the fallback player). anilistId is required; malId is optional.
function embedSources(anilistId, malId, ep, lang) {
  const want = lang === 'dub' ? 'dub' : 'sub';
  return [
    mkEmbedUrl('ani', anilistId, ep, want),
    mkEmbedUrl('mal', malId, ep, want),
  ].filter(Boolean);
}

async function search(q) {
  const query = String(q || '').trim();
  if (!query) return [];
  const body = {
    query: `query($s:String){Page(perPage:12){media(search:$s,type:ANIME,sort:SEARCH_MATCH){id idMal episodes format seasonYear title{romaji english} coverImage{medium}}}}`,
    variables: { s: query },
  };
  const r = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`AniList said ${r.status}`);
  const j = await r.json();
  const list = (j && j.data && j.data.Page && j.data.Page.media) || [];
  return list.map(m => ({
    id: m.id,
    mal: m.idMal || 0,
    title: (m.title && (m.title.english || m.title.romaji)) || `#${m.id}`,
    episodes: Number(m.episodes) || 0,
    year: m.seasonYear || null,
    format: m.format || '',
    poster: (m.coverImage && m.coverImage.medium) || '',
  })).filter(m => m.id > 0);
}

// ----------------------------------------------------------------- source resolution (server-side)

const absolutize = (u, host) => { try { return new URL(String(u || ''), `https://${host}/`).href; } catch { return ''; } };
const numRange = r => {
  if (!r || typeof r !== 'object') return null;
  const start = Number(r.start ?? r.startTime ?? r.from);
  const end = Number(r.end ?? r.endTime ?? r.to);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { start, end } : null;
};

// MegaPlay's JSON source API (and AniFlow-compatible shapes). Returns the raw m3u8 + subtitle
// tracks + intro/outro, or null. We never trust these to be same-origin: they are absolutized
// against the host they came from and only reached again through the signed proxy below.
function parseSource(j, host) {
  if (!j || typeof j !== 'object') return null;
  const s = (j.stream && typeof j.stream === 'object') ? j.stream : j;
  const first = Array.isArray(s.sources) && s.sources[0];
  let url = s.source || s.url || s.file || (first && (first.file || first.url)) || '';
  url = absolutize(url, host);
  if (!/^https?:\/\//i.test(url)) return null;
  const rawTracks = s.tracks || s.subtitles || j.tracks || j.subtitles || [];
  const subtitles = (Array.isArray(rawTracks) ? rawTracks : [])
    .map(t => ({
      url: absolutize(t && (t.file || t.url), host),
      label: (t && (t.label || t.language || t.lang)) || 'Subtitles',
      lang: String((t && (t.lang || t.language || t.srclang)) || '').toLowerCase().slice(0, 8),
      kind: String((t && t.kind) || '').toLowerCase(),
    }))
    .filter(t => /^https?:\/\//i.test(t.url) && t.kind !== 'thumbnails');
  const skip = s.skipTimes || s.skip || {};
  const intro = numRange(j.intro || s.intro || skip.intro);
  const outro = numRange(j.outro || s.outro || skip.outro);
  return { url, subtitles, intro, outro };
}

// The JSON source API and the /vid stream both live on megavid.buzz and are same-origin-gated:
// the API checks Origin, the stream/segments check Referer, and both must be megavid's own origin
// (megaplay.buzz only serves the iframe embed). First hit wins.
const STREAM_HOST = 'https://megavid.buzz';
async function resolveStream(anilistId, malId, ep, lang) {
  const want = lang === 'dub' ? 'dub' : 'sub';
  const n = Math.max(1, Math.trunc(Number(ep)) || 1);
  const ani = Math.trunc(Number(anilistId)) || 0;
  const mal = Math.trunc(Number(malId)) || 0;
  const streamReferer = STREAM_HOST + '/'; // the stream + its segments are hotlink-gated to this
  const apis = [];
  if (ani > 0) apis.push(`${STREAM_HOST}/api/ani/${ani}/${n}/${want}`);
  if (mal > 0) apis.push(`${STREAM_HOST}/api/mal/${mal}/${n}/${want}`);
  for (const api of apis) {
    try {
      const r = await fetch(api, {
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': streamReferer,
          'Origin': STREAM_HOST,
          'X-Requested-With': 'XMLHttpRequest',
        },
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) continue;
      const j = await r.json().catch(() => null);
      if (!j || j.success === false) continue;
      const parsed = parseSource(j, 'megavid.buzz');
      if (parsed && parsed.url) return { ...parsed, referer: streamReferer };
    } catch { /* try the next candidate */ }
  }
  return null;
}

// ----------------------------------------------------------------- signed proxy links

const b64 = s => Buffer.from(String(s), 'utf8').toString('base64url');
const unb64 = s => Buffer.from(String(s), 'base64url').toString('utf8');
const sign = data => crypto.createHmac('sha256', SECRET).update(data).digest('hex').slice(0, 20);
const EXT = { m3u8: '.m3u8', seg: '.ts', sub: '.vtt' };

// kind: 'm3u8' | 'seg' | 'sub'. Carries the upstream URL + the Referer that upstream expects.
function signedPath(kind, upstreamUrl, referer) {
  const data = b64(JSON.stringify([String(upstreamUrl), String(referer || PRIMARY + '/')]));
  return `/anime/${kind}/${data}/${sign(data)}${EXT[kind] || ''}`;
}
function unsign(data, sig) {
  if (!data || sign(data) !== sig) return null;
  try {
    const [url, referer] = JSON.parse(unb64(data));
    if (!/^https?:\/\//i.test(url)) return null;
    return { url, referer: /^https?:\/\//i.test(referer) ? referer : PRIMARY + '/' };
  } catch { return null; }
}
// Parse "/anime/<kind>/<data>/<sig>[.ext]" → { kind, url, referer } or null.
const PATH_RE = /^\/anime\/(m3u8|seg|sub)\/([A-Za-z0-9_-]+)\/([0-9a-f]{20})(?:\.[a-z0-9]+)?$/;
function parseProxyPath(p) {
  const m = PATH_RE.exec(p);
  if (!m) return null;
  const info = unsign(m[2], m[3]);
  return info ? { kind: m[1], ...info } : null;
}

// ----------------------------------------------------------------- SSRF guard + upstream fetch

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || a >= 224;
  }
  const l = String(ip).toLowerCase();
  if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7));
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
}
async function hostAllowed(host) {
  if (!host || /^(localhost|.*\.local)$/i.test(host)) return false;
  if (net.isIP(host)) return !isPrivateIp(host);
  try { const addrs = await dns.lookup(host, { all: true }); return addrs.length > 0 && !addrs.some(x => isPrivateIp(x.address)); }
  catch { return false; }
}
async function fetchUpstream(url, referer, extraHeaders) {
  let u;
  try { u = new URL(url); } catch { throw new Error('bad url'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('bad protocol');
  if (!(await hostAllowed(u.hostname))) throw new Error('blocked host');
  const headers = { 'User-Agent': UA, 'Accept': '*/*', 'Referer': referer };
  try { headers['Origin'] = new URL(referer).origin; } catch { /* no origin */ }
  return fetch(url, { headers: { ...headers, ...(extraHeaders || {}) }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
}

// Rewrite every URI in an HLS playlist to a signed proxy link, carrying the room-auth query (k/c)
// through to the children so they authorize the same way the master did.
function rewriteM3u8(text, baseUrl, referer, query) {
  const q = query ? `?${query}` : '';
  const abs = rel => { try { return new URL(rel, baseUrl).href; } catch { return rel; } };
  const isPlaylist = (url, tag) => /\.m3u8(?:[?#]|$)/i.test(url) || /#EXT-X-(?:STREAM-INF|MEDIA|I-FRAME-STREAM-INF)/i.test(tag || '');
  return String(text).split(/\r?\n/).map(line => {
    const t = line.trim();
    if (!t) return line;
    if (t[0] === '#') {
      return line.replace(/URI="([^"]+)"/g, (_, uri) => {
        const a = abs(uri);
        const kind = isPlaylist(a, t) ? 'm3u8' : 'seg';
        return `URI="${signedPath(kind, a, referer)}${q}"`;
      });
    }
    const a = abs(t);
    return signedPath(isPlaylist(a) ? 'm3u8' : 'seg', a, referer) + q;
  }).join('\n');
}

// SubRip → WebVTT (browsers' <track> needs VTT). Already-VTT text passes through.
function toVtt(text) {
  const s = String(text || '');
  if (/^﻿?WEBVTT/.test(s)) return s.replace(/^﻿/, '');
  const body = s.replace(/\r\n/g, '\n').replace(/^\d+\s*$/gm, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${body.replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

module.exports = { search, embedSources, resolveStream, init, signedPath, parseProxyPath, fetchUpstream, rewriteM3u8, toVtt, Readable };
