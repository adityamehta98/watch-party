'use strict';

const crypto = require('crypto');
const { FreeMedia } = require('./free-media');

const IMAGE = 'https://image.tmdb.org/t/p/w342';
const TYPES = new Set(['movie', 'tv']);
const WATCH_LABELS = { netflix: 'Netflix', prime: 'Prime Video', hulu: 'Hulu', peacock: 'Peacock', max: 'Max', disney: 'Disney+', paramount: 'Paramount+', appletv: 'Apple TV+', crunchyroll: 'Crunchyroll' };
function providerService(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('netflix')) return 'netflix';
  if (n.includes('prime video') || (n.includes('amazon') && n.includes('prime'))) return 'prime';
  if (n.includes('hulu')) return 'hulu';
  if (n.includes('peacock')) return 'peacock';
  if (n.includes('max') || n.includes('hbo')) return 'max';
  if (n.includes('disney')) return 'disney';
  if (n.includes('paramount')) return 'paramount';
  if (n.includes('apple tv')) return 'appletv';
  if (n.includes('crunchyroll')) return 'crunchyroll';
  return null;
}

const int = value => Math.max(0, Math.trunc(Number(value)) || 0);
const clean = (value, length = 160) => String(value || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, length);

class Catalog {
  constructor({ config, remoteMedia, fetchFn, freeMedia } = {}) {
    this.config = config || {};
    this.remoteMedia = remoteMedia;
    this.fetchFn = fetchFn || globalThis.fetch;
    this.freeMedia = freeMedia || new FreeMedia({ fetchFn: this.fetchFn, secret: this.config.adminKey });
  }

  tmdbConfigured() { return !!clean(this.config.tmdbToken, 1024); }
  freeEnabled() { return this.config.freeMedia !== false; }
  configured() { return this.tmdbConfigured() || this.freeEnabled(); }
  sourceCount() { return this.sources().length; }

  sources() {
    const list = Array.isArray(this.config.movieTvSources) ? this.config.movieTvSources : [];
    return list.map((source, index) => this.normalizeSource(source, index)).filter(Boolean);
  }

  normalizeSource(source, index) {
    if (!source || typeof source !== 'object' || !TYPES.has(source.type)) return null;
    const tmdbId = int(source.tmdbId);
    const url = String(source.url || '').trim();
    if (!tmdbId || !/^https?:\/\//i.test(url)) return null;
    const season = source.type === 'tv' ? int(source.season) : 0;
    const episode = source.type === 'tv' ? int(source.episode) : 0;
    if (source.type === 'tv' && (!season || !episode)) return null;
    const language = clean(source.language || 'und', 20).toLowerCase() || 'und';
    const languageLabel = clean(source.languageLabel || language.toUpperCase(), 50) || language.toUpperCase();
    const quality = Math.max(0, Math.min(4320, int(source.quality)));
    const format = source.format === 'hls' || /\.m3u8(?:[?#]|$)/i.test(url) ? 'hls' : 'file';
    const headers = source.headers && typeof source.headers === 'object' && !Array.isArray(source.headers) ? source.headers : {};
    const subtitles = (Array.isArray(source.subtitles) ? source.subtitles : []).slice(0, 20).map((subtitle, subIndex) => ({
      key: `s${subIndex}`,
      label: clean(subtitle && (subtitle.label || subtitle.language || `Track ${subIndex + 1}`), 60),
      lang: clean(subtitle && (subtitle.lang || subtitle.language), 12).toLowerCase(),
      url: String(subtitle && subtitle.url || '').trim(),
      referer: String(subtitle && subtitle.referer || source.referer || '').trim(),
      headers: subtitle && subtitle.headers && typeof subtitle.headers === 'object' ? subtitle.headers : headers,
    })).filter(subtitle => /^https?:\/\//i.test(subtitle.url));
    return {
      index, type: source.type, tmdbId, season, episode, language, languageLabel, quality, format, url,
      duration: Math.max(0, Number(source.duration) || 0), referer: String(source.referer || '').trim(), headers, subtitles,
    };
  }

  ref(value = {}) {
    const type = TYPES.has(value.type) ? value.type : '';
    const tmdbId = int(value.tmdbId || value.id);
    const season = type === 'tv' ? int(value.season) : 0;
    const episode = type === 'tv' ? int(value.episode) : 0;
    return type && tmdbId && (type === 'movie' || (season && episode)) ? { type, tmdbId, season, episode } : null;
  }

  matching(value, includeAllEpisodes = false) {
    const type = TYPES.has(value && value.type) ? value.type : '';
    const tmdbId = int(value && (value.tmdbId || value.id));
    const season = int(value && value.season), episode = int(value && value.episode);
    if (!type || !tmdbId || (type === 'tv' && !includeAllEpisodes && (!season || !episode))) return [];
    return this.sources().filter(source => source.type === type && source.tmdbId === tmdbId
      && (type === 'movie' || includeAllEpisodes || (source.season === season && source.episode === episode)));
  }

  languages(value) {
    const best = new Map();
    for (const source of this.matching(value)) {
      const current = best.get(source.language);
      if (!current || source.quality > current.bestQuality) best.set(source.language, {
        code: source.language, label: source.languageLabel, bestQuality: source.quality || null,
      });
    }
    return [...best.values()].sort((a, b) => a.label.localeCompare(b.label));
  }

  hasSources(value) { return this.matching(value, true).length > 0; }

  async request(path, params = {}) {
    const token = clean(this.config.tmdbToken, 1024);
    if (!token) throw new Error('Add a TMDB Read Access Token in Room settings first.');
    const url = new URL(`https://api.themoviedb.org/3${path}`);
    for (const [key, value] of Object.entries({ language: 'en-US', ...params })) if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    const response = await this.fetchFn(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12000) });
    if (!response.ok) {
      if (response.status === 401) throw new Error('TMDB rejected the token. Check it in Room settings.');
      throw new Error(`TMDB said ${response.status}`);
    }
    return response.json();
  }

  item(result) {
    const type = result.media_type;
    if (!TYPES.has(type)) return null;
    const tmdbId = int(result.id);
    const title = clean(type === 'movie' ? result.title : result.name, 140);
    const date = String(type === 'movie' ? result.release_date : result.first_air_date || '');
    if (!tmdbId || !title) return null;
    const ref = { type, tmdbId };
    return {
      type, tmdbId, title, year: /^\d{4}/.test(date) ? date.slice(0, 4) : null,
      overview: clean(result.overview, 500), rating: Number(result.vote_average) || 0,
      poster: result.poster_path ? IMAGE + result.poster_path : '',
      languages: type === 'movie' ? this.languages(ref) : [], hasSources: this.hasSources(ref),
    };
  }

  async search(query) {
    const q = clean(query, 150);
    if (!q) return [];
    const tmdb = this.tmdbConfigured()
      ? this.request('/search/multi', { query: q, include_adult: false, page: 1 }).then(data => (Array.isArray(data.results) ? data.results : []).map(result => this.item(result)).filter(Boolean).slice(0, 14))
      : Promise.resolve([]);
    const free = this.freeEnabled() ? this.freeMedia.search(q) : Promise.resolve([]);
    const [tmdbResult, freeResult] = await Promise.allSettled([tmdb, free]);
    const paid = tmdbResult.status === 'fulfilled' ? tmdbResult.value : [];
    const open = freeResult.status === 'fulfilled' ? freeResult.value : [];
    if (!paid.length && !open.length && tmdbResult.status === 'rejected') throw tmdbResult.reason;
    if (!paid.length && !open.length && freeResult.status === 'rejected' && !this.tmdbConfigured()) throw new Error('The free catalog could not be reached right now.');
    return [...open, ...paid];
  }

  async details(type, id) {
    if (!TYPES.has(type) || !int(id)) throw new Error('Invalid title.');
    const data = await this.request(`/${type}/${int(id)}`);
    const date = String(type === 'movie' ? data.release_date : data.first_air_date || '');
    const result = {
      type, tmdbId: int(data.id), title: clean(type === 'movie' ? data.title : data.name, 140),
      year: /^\d{4}/.test(date) ? date.slice(0, 4) : null,
      overview: clean(data.overview, 500), poster: data.poster_path ? IMAGE + data.poster_path : '',
      languages: type === 'movie' ? this.languages({ type, tmdbId: id }) : [], seasons: [],
    };
    if (type === 'tv') result.seasons = (Array.isArray(data.seasons) ? data.seasons : []).filter(season => int(season.season_number) > 0).map(season => ({
      number: int(season.season_number), name: clean(season.name, 80) || `Season ${int(season.season_number)}`,
      episodes: int(season.episode_count), available: this.sources().some(source => source.type === 'tv' && source.tmdbId === int(id) && source.season === int(season.season_number)),
    }));
    return result;
  }

  async season(tvId, seasonNumber) {
    const id = int(tvId), season = int(seasonNumber);
    if (!id || !season) throw new Error('Invalid season.');
    const data = await this.request(`/tv/${id}/season/${season}`);
    return {
      tmdbId: id, season, name: clean(data.name, 100) || `Season ${season}`,
      episodes: (Array.isArray(data.episodes) ? data.episodes : []).map(item => {
        const episode = int(item.episode_number);
        const ref = { type: 'tv', tmdbId: id, season, episode };
        return { number: episode, name: clean(item.name, 120) || `Episode ${episode}`, overview: clean(item.overview, 300), languages: this.languages(ref) };
      }).filter(item => item.number > 0),
    };
  }

  async providers(type, id) {
    if (!TYPES.has(type) || !int(id)) throw new Error('Invalid title.');
    const data = await this.request(`/${type}/${int(id)}/watch/providers`);
    const region = data && data.results && data.results.US;
    const flat = region && Array.isArray(region.flatrate) ? region.flatrate : [];
    const seen = new Set(), out = [];
    for (const provider of flat) {
      const sid = providerService(provider && provider.provider_name);
      if (sid && !seen.has(sid)) { seen.add(sid); out.push({ id: sid, name: WATCH_LABELS[sid] || sid }); }
    }
    return out;
  }

  resolve(value, language) {
    if (value && value.type === 'free') {
      const item = this.freeMedia.resolve(String(value.freeId || ''), clean(language, 20).toLowerCase());
      if (!item) throw new Error('That free title expired or is unavailable. Search for it again.');
      const ref = { type: 'free', freeId: String(value.freeId) };
      const sourceId = crypto.createHash('sha1').update(`free:${item.identifier}:${item.url}`).digest('hex').slice(0, 16);
      const options = { scope: sourceId };
      return {
        ref, language: item.language.code, languageLabel: item.language.label,
        languages: [{ code: item.language.code, label: item.language.label, bestQuality: item.quality }], quality: item.quality || null,
        duration: item.duration || null, hlsPath: null, urlPath: this.remoteMedia.signedPath('media', item.url, options),
        subtitles: item.subtitles.map(subtitle => ({ key: subtitle.key, label: subtitle.label, lang: subtitle.lang, url: this.remoteMedia.signedPath('sub', subtitle.url, options) })),
        hasNext: false, sourceId,
        attribution: { provider: 'Internet Archive', creator: item.creator, licenseLabel: item.license.label, licenseUrl: item.license.url, sourcePage: item.sourcePage },
      };
    }
    const ref = this.ref(value);
    if (!ref) throw new Error('Invalid movie or episode.');
    const code = clean(language, 20).toLowerCase();
    const choices = this.matching(ref).filter(source => source.language === code).sort((a, b) => b.quality - a.quality || Number(b.format === 'hls') - Number(a.format === 'hls'));
    if (!choices.length) throw new Error('That language is not available for this title.');
    const source = choices[0];
    const sourceId = crypto.createHash('sha1').update(`${source.type}:${source.tmdbId}:${source.season}:${source.episode}:${source.language}:${source.url}`).digest('hex').slice(0, 16);
    const options = { referer: source.referer, headers: source.headers, scope: sourceId };
    const hlsPath = source.format === 'hls' ? this.remoteMedia.signedPath('m3u8', source.url, options) : null;
    const urlPath = source.format === 'file' ? this.remoteMedia.signedPath('media', source.url, options) : null;
    const subtitles = source.subtitles.map(subtitle => ({
      key: subtitle.key, label: subtitle.label, lang: subtitle.lang,
      url: this.remoteMedia.signedPath('sub', subtitle.url, { referer: subtitle.referer, headers: subtitle.headers, scope: sourceId }),
    }));
    const next = ref.type === 'tv' ? { ...ref, episode: ref.episode + 1 } : null;
    return {
      ref, language: source.language, languageLabel: source.languageLabel, languages: this.languages(ref), quality: source.quality || null,
      duration: source.duration || null, hlsPath, urlPath, subtitles,
      hasNext: !!(next && this.matching(next).length),
      sourceId,
    };
  }
}

module.exports = { Catalog };
