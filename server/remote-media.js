'use strict';

// Proxies only media targets registered by the server. Browser clients receive an
// opaque, signed path rather than the upstream URL (which may contain a private
// access token). The catalog module is the only production caller that registers
// targets, so guests cannot turn this into an open proxy.
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { Readable } = require('stream');

let secret = 'watch-party-remote-media';
const targets = new Map();
const MAX_TARGETS = 12000;

function init(value) { if (value) secret = String(value); }

function normalizeHeaders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) continue;
    const text = String(raw || '').replace(/[\r\n]/g, '').slice(0, 2048);
    if (text) out[name] = text;
  }
  return out;
}

function remember(kind, url, options = {}) {
  const target = {
    kind,
    url: String(url || ''),
    scope: String(options.scope || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64),
    referer: /^https?:\/\//i.test(String(options.referer || '')) ? String(options.referer) : '',
    headers: normalizeHeaders(options.headers),
  };
  if (!/^https?:\/\//i.test(target.url)) return null;
  const json = JSON.stringify(target);
  const id = crypto.createHmac('sha256', secret).update(json).digest('hex').slice(0, 32);
  if (targets.has(id)) targets.delete(id);
  targets.set(id, target);
  while (targets.size > MAX_TARGETS) targets.delete(targets.keys().next().value);
  return id;
}

const EXT = { m3u8: '.m3u8', media: '.bin', sub: '.vtt' };
function signedPath(kind, url, options) {
  if (!Object.hasOwn(EXT, kind)) return null;
  const id = remember(kind, url, options);
  return id ? `/catalog-media/${kind}/${id}${EXT[kind]}` : null;
}

const PATH_RE = /^\/catalog-media\/(m3u8|media|sub)\/([0-9a-f]{32})(?:\.[a-z0-9]+)?$/;
function parsePath(pathname) {
  const match = PATH_RE.exec(String(pathname || ''));
  if (!match) return null;
  const target = targets.get(match[2]);
  if (!target || target.kind !== match[1]) return null;
  // Refresh the LRU position while a title is actively playing.
  targets.delete(match[2]); targets.set(match[2], target);
  return { ...target };
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 192 && b === 168)
      || (a === 172 && b >= 16 && b <= 31) || a >= 224;
  }
  const lower = String(ip).toLowerCase();
  if (lower.startsWith('::ffff:')) return isPrivateIp(lower.slice(7));
  return lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
}

async function hostAllowed(host) {
  if (!host || /^(localhost|.*\.local)$/i.test(host)) return false;
  if (net.isIP(host)) return !isPrivateIp(host);
  try {
    const addresses = await dns.lookup(host, { all: true });
    return addresses.length > 0 && !addresses.some(item => isPrivateIp(item.address));
  } catch { return false; }
}

async function fetchUpstream(target, extraHeaders = {}) {
  const headers = { 'User-Agent': 'WatchParty/1.0', Accept: '*/*', ...normalizeHeaders(target.headers) };
  if (target.referer) {
    headers.Referer = target.referer;
    try { headers.Origin = new URL(target.referer).origin; } catch { /* optional */ }
  }
  Object.assign(headers, normalizeHeaders(extraHeaders));
  let next = target.url;
  for (let redirects = 0; redirects <= 5; redirects++) {
    let url;
    try { url = new URL(next); } catch { throw new Error('bad url'); }
    if (!/^https?:$/.test(url.protocol) || !(await hostAllowed(url.hostname))) throw new Error('blocked host');
    const response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location || redirects === 5) throw new Error('bad redirect');
    next = new URL(location, url).href;
  }
  throw new Error('too many redirects');
}

function rewriteM3u8(text, baseUrl, target, query) {
  const auth = query ? `?${query}` : '';
  const absolute = value => { try { return new URL(value, baseUrl).href; } catch { return ''; } };
  const isPlaylist = (url, tag) => /\.m3u8(?:[?#]|$)/i.test(url) || /#EXT-X-(?:STREAM-INF|MEDIA|I-FRAME-STREAM-INF)/i.test(tag || '');
  const pathFor = (raw, tag = '') => {
    const url = absolute(raw);
    if (!url) return raw;
    return signedPath(isPlaylist(url, tag) ? 'm3u8' : 'media', url, target) + auth;
  };
  return String(text).split(/\r?\n/).map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed[0] === '#') return line.replace(/URI="([^"]+)"/g, (_all, uri) => `URI="${pathFor(uri, trimmed)}"`);
    return pathFor(trimmed);
  }).join('\n');
}

function toVtt(text) {
  const source = String(text || '');
  if (/^﻿?WEBVTT/.test(source)) return source.replace(/^﻿/, '');
  const body = source.replace(/\r\n/g, '\n').replace(/^\d+\s*$/gm, '').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return `WEBVTT\n\n${body.replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

module.exports = { init, signedPath, parsePath, fetchUpstream, rewriteM3u8, toVtt, Readable, _targets: targets };
