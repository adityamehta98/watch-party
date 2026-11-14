'use strict';

// Proxies only media targets registered by the server. Browser clients receive an
// opaque, signed path rather than the upstream URL (which may contain a private
// access token). The catalog module is the only production caller that registers
// targets, so guests cannot turn this into an open proxy.
const crypto = require('crypto');
const { fetchPublic } = require('./upstream');

let secret = 'watch-party-remote-media';
const targets = new Map();
const MAX_TARGETS = 12000;

function init(value) { if (value) secret = String(value); }

function normalizeHeaders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) continue;
    if (/^(?:host|connection|content-length|transfer-encoding|proxy-authorization|upgrade|trailer|te)$/i.test(name)) continue;
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
    headerOrigin: String(options.headerOrigin || ''),
  };
  if (!/^https?:\/\//i.test(target.url)) return null;
  try { target.headerOrigin ||= new URL(target.url).origin; } catch { return null; }
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

async function fetchUpstream(target, extraHeaders = {}) {
  const configured = !target.headerOrigin || new URL(target.url).origin === target.headerOrigin ? normalizeHeaders(target.headers) : {};
  const headers = { 'User-Agent': 'WatchParty/1.0', Accept: '*/*', ...configured };
  if (target.referer) {
    headers.Referer = target.referer;
    try { headers.Origin = new URL(target.referer).origin; } catch { /* optional */ }
  }
  Object.assign(headers, normalizeHeaders(extraHeaders));
  return fetchPublic(target.url, { headers });
}

function rewriteM3u8(text, baseUrl, target, query) {
  const auth = query ? `?${query}` : '';
  const absolute = value => { try { return new URL(value, baseUrl).href; } catch { return ''; } };
  const isPlaylist = (url, tag) => /\.m3u8(?:[?#]|$)/i.test(url) || /#EXT-X-(?:STREAM-INF|MEDIA|I-FRAME-STREAM-INF)/i.test(tag || '');
  const pathFor = (raw, tag = '') => {
    const url = absolute(raw);
    if (!url) return raw;
    const path = signedPath(isPlaylist(url, tag) ? 'm3u8' : 'media', url, target);
    return path ? path + auth : '';
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

module.exports = { init, signedPath, parsePath, fetchUpstream, rewriteM3u8, toVtt, _targets: targets };
