'use strict';

const crypto = require('crypto');

const SEARCH_URL = 'https://archive.org/advancedsearch.php';
const METADATA_URL = 'https://archive.org/metadata/';
const DOWNLOAD_URL = 'https://archive.org/download/';
const SAFE_COLLECTIONS = new Set(['prelinger', 'feature_films', 'silent_films', 'classic_tv']);
const MAX_CACHE = 500;

const clean = (value, length = 180) => String(value || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, length);
const list = value => Array.isArray(value) ? value : value == null ? [] : [value];
const int = value => Math.max(0, Math.trunc(Number(value)) || 0);

function licenseInfo(value) {
  const raw = clean(list(value)[0], 500);
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (!/^(?:www\.)?creativecommons\.org$/i.test(url.hostname) || !/^https?:$/.test(url.protocol)) return null;
  const path = url.pathname.toLowerCase().replace(/\/+$/, '/') || '/';
  const allowed = [
    ['/publicdomain/zero/', 'CC0'],
    ['/publicdomain/mark/', 'Public Domain'],
    ['/licenses/by/', 'CC BY'],
    ['/licenses/by-sa/', 'CC BY-SA'],
  ].find(([prefix]) => path.startsWith(prefix));
  return allowed ? { label: allowed[1], url: url.href } : null;
}

function languageInfo(value) {
  const raw = clean(list(value)[0] || 'Original audio', 50);
  const key = raw.toLowerCase();
  const known = {
    en: ['en', 'English'], eng: ['en', 'English'], english: ['en', 'English'],
    es: ['es', 'Spanish'], spa: ['es', 'Spanish'], spanish: ['es', 'Spanish'],
    fr: ['fr', 'French'], fre: ['fr', 'French'], fra: ['fr', 'French'], french: ['fr', 'French'],
    de: ['de', 'German'], ger: ['de', 'German'], deu: ['de', 'German'], german: ['de', 'German'],
    it: ['it', 'Italian'], ita: ['it', 'Italian'], italian: ['it', 'Italian'],
    pt: ['pt', 'Portuguese'], por: ['pt', 'Portuguese'], portuguese: ['pt', 'Portuguese'],
    ja: ['ja', 'Japanese'], jpn: ['ja', 'Japanese'], japanese: ['ja', 'Japanese'],
    hi: ['hi', 'Hindi'], hin: ['hi', 'Hindi'], hindi: ['hi', 'Hindi'],
  };
  const match = known[key];
  return match ? { code: match[0], label: match[1] } : { code: 'und', label: raw || 'Original audio' };
}

function durationSeconds(value) {
  if (Number.isFinite(Number(value))) return Math.max(0, Number(value));
  const parts = String(value || '').split(':').map(Number);
  if (!parts.length || parts.some(part => !Number.isFinite(part))) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function qualityOf(file) {
  const explicit = int(file.height);
  if (explicit) return Math.min(4320, explicit);
  const match = String(file.name || '').match(/(?:^|[^0-9])(2160|1440|1080|720|576|480|360)p?(?:[^0-9]|$)/i);
  return match ? Number(match[1]) : 0;
}

function playableFiles(files) {
  return list(files).filter(file => file && /\.(?:mp4|m4v)$/i.test(String(file.name || ''))
    && !/(?:thumb|sample|trailer)/i.test(String(file.name || ''))
    && !/metadata/i.test(String(file.format || '')))
    .map(file => ({ ...file, quality: qualityOf(file), bytes: Math.max(0, Number(file.size) || 0) }))
    .sort((a, b) => b.quality - a.quality || b.bytes - a.bytes);
}

class FreeMedia {
  constructor({ fetchFn, secret } = {}) {
    this.fetchFn = fetchFn || globalThis.fetch;
    this.secret = String(secret || 'watch-party-free-media');
    this.cache = new Map();
    this.byToken = new Map();
  }

  async json(url) {
    const response = await this.fetchFn(url, { headers: { Accept: 'application/json', 'User-Agent': 'WatchParty/1.0' }, signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`Internet Archive said ${response.status}`);
    return response.json();
  }

  token(identifier) {
    return crypto.createHmac('sha256', this.secret).update(identifier).digest('hex').slice(0, 24);
  }

  remember(item) {
    const token = this.token(item.identifier);
    if (this.byToken.has(token)) this.byToken.delete(token);
    this.byToken.set(token, item);
    while (this.byToken.size > MAX_CACHE) this.byToken.delete(this.byToken.keys().next().value);
    return token;
  }

  async load(identifier, hint = {}) {
    const id = String(identifier || '');
    if (!/^[A-Za-z0-9._-]{5,160}$/.test(id)) return null;
    const cached = this.cache.get(id);
    if (cached && Date.now() - cached.at < 30 * 60 * 1000) return cached.value;
    const pending = this.json(METADATA_URL + encodeURIComponent(id)).then(record => this.normalize(id, record, hint)).catch(() => null);
    this.cache.set(id, { at: Date.now(), value: pending });
    const value = await pending;
    this.cache.set(id, { at: Date.now(), value });
    return value;
  }

  normalize(identifier, record, hint) {
    const metadata = record && record.metadata || {};
    if (metadata.mediatype !== 'movies' || String(record.is_dark).toLowerCase() === 'true' || String(record.nodownload).toLowerCase() === 'true' || String(metadata['access-restricted-item']).toLowerCase() === 'true') return null;
    const collections = list(metadata.collection || hint.collection).map(String);
    if (!collections.some(collection => SAFE_COLLECTIONS.has(collection))) return null;
    const license = licenseInfo(metadata.licenseurl || hint.licenseurl);
    if (!license) return null;
    const creator = clean(list(metadata.creator)[0], 120);
    if ((license.label === 'CC BY' || license.label === 'CC BY-SA') && !creator) return null;
    const files = playableFiles(record.files);
    if (!files.length) return null;
    const best = files[0];
    const language = languageInfo(metadata.language || hint.language);
    const subtitles = list(record.files).filter(file => file && /\.(?:vtt|srt)$/i.test(String(file.name || '')) && Number(file.size || 0) < 10 * 1024 * 1024).slice(0, 12).map((file, index) => ({
      key: `ia${index}`,
      label: clean(file.title || file.name.replace(/\.(?:vtt|srt)$/i, ''), 70) || `Subtitles ${index + 1}`,
      lang: language.code,
      url: DOWNLOAD_URL + encodeURIComponent(identifier) + '/' + encodeURIComponent(file.name),
    }));
    const date = clean(metadata.date || metadata.year || hint.date, 30);
    const title = clean(metadata.title || hint.title, 140);
    if (!title) return null;
    return {
      identifier, title, year: /^\d{4}/.test(date) ? date.slice(0, 4) : null,
      overview: clean(list(metadata.description)[0] || hint.description, 500), creator,
      license, language, quality: best.quality || null,
      duration: durationSeconds(best.length || metadata.runtime),
      url: DOWNLOAD_URL + encodeURIComponent(identifier) + '/' + encodeURIComponent(best.name), subtitles,
      sourcePage: `https://archive.org/details/${encodeURIComponent(identifier)}`,
    };
  }

  async search(query) {
    const words = clean(query, 120).split(/\s+/).map(word => word.replace(/[^\p{L}\p{N}'-]/gu, '')).filter(Boolean).slice(0, 8);
    if (!words.length) return [];
    const titleQuery = words.map(word => `"${word.replace(/"/g, '')}"`).join(' AND ');
    const collections = [...SAFE_COLLECTIONS].map(collection => `collection:${collection}`).join(' OR ');
    const url = new URL(SEARCH_URL);
    url.searchParams.set('q', `title:(${titleQuery}) AND mediatype:movies AND (${collections})`);
    for (const field of ['identifier', 'title', 'description', 'date', 'year', 'language', 'licenseurl', 'collection', 'downloads']) url.searchParams.append('fl[]', field);
    url.searchParams.append('sort[]', 'downloads desc');
    url.searchParams.set('rows', '8');
    url.searchParams.set('page', '1');
    url.searchParams.set('output', 'json');
    const data = await this.json(url);
    const docs = list(data && data.response && data.response.docs).slice(0, 8);
    const loaded = await Promise.all(docs.map(doc => this.load(doc.identifier, doc)));
    return loaded.filter(Boolean).slice(0, 5).map(item => ({
      type: 'free', provider: 'internet-archive', freeId: this.remember(item), title: item.title, year: item.year,
      overview: item.overview, rating: 0, poster: '', hasSources: true,
      languages: [{ code: item.language.code, label: item.language.label, bestQuality: item.quality }],
      attribution: { provider: 'Internet Archive', creator: item.creator, licenseLabel: item.license.label, licenseUrl: item.license.url, sourcePage: item.sourcePage },
    }));
  }

  resolve(token, language) {
    const item = this.byToken.get(String(token || ''));
    if (!item || item.language.code !== clean(language, 20).toLowerCase()) return null;
    return item;
  }
}

module.exports = { FreeMedia, licenseInfo, playableFiles };
