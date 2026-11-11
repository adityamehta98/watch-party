'use strict';
const services = require('./services');
const { cleanNetflixMetadata } = require('./netflix-metadata');
const { wpPrimeAsset, wpPrimeContentTitle } = require('../extension/services');

function cleanPlayback(value) {
  if (!value || value.ad || value.preview || !['file', 'service', 'youtube', 'catalog'].includes(value.kind) || !/^[a-z0-9]{1,80}$/i.test(value.id || '') ||
      !Number.isFinite(value.position) || value.position < 0 || !Number.isFinite(value.duration) || value.duration <= 0) return null;
  let identity = {};
  if (value.kind === 'service' || value.kind === 'youtube') {
    try { const url = new URL(value.url); if (url.username || url.password) return null; } catch { return null; }
    const info = services.identify(value.url);
    if (!info || info.service !== value.service || value.browsing) return null;
    if (info.service === 'netflix' && !/^https:\/\/[^/]+\/watch\/\d+$/.test(info.url)) return null;
    if (info.service === 'prime' && (!wpPrimeAsset(info.url) || !wpPrimeContentTitle(value.title))) return null;
    identity = { url: info.url, service: info.service, serviceName: info.name };
    const netflix = info.service === 'netflix' && cleanNetflixMetadata(value.netflix);
    if (netflix) identity.netflix = netflix;
  }
  if (value.kind === 'catalog') {
    const ref = value.catalogRef;
    if (!ref || !['movie', 'tv', 'free'].includes(ref.type)) return null;
    identity = { catalogRef: { type: ref.type, tmdbId: Number(ref.tmdbId) || 0,
      season: Number(ref.season) || 1, episode: Number(ref.episode) || 1, freeId: String(ref.freeId || '').slice(0, 100) },
      language: String(value.language || '').slice(0, 20), catalogTitle: String(value.catalogTitle || value.title || '').slice(0, 140) };
  }
  return { id: value.id, kind: value.kind, ...identity,
    title: String(value.title || 'Movie').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 140),
    position: Math.min(value.position, value.duration, 86400), duration: Math.min(value.duration, 86400),
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0, hidden: value.hidden === true };
}
module.exports = { cleanPlayback };
