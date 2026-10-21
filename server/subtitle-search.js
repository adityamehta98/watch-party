'use strict';

const fs = require('fs');
const path = require('path');
const MAPPINGS_URL = 'https://github.com/anibridge/anibridge-mappings/releases/download/v3/mappings.min.json';

function range(value) {
  const m = /^(\d+)(?:-(\d*))?$/.exec(value);
  return m ? { start: +m[1], end: m[2] === undefined ? +m[1] : m[2] ? +m[2] : Infinity } : null;
}

// Only one-to-one episode mappings are safe for an external subtitle file.
function mappedEpisode(rules, episode) {
  for (const [source, target] of Object.entries(rules || {})) {
    const from = range(source);
    if (!from || episode < from.start || episode > from.end || /\|/.test(target)) continue;
    let offset = episode - from.start;
    for (const segment of target.split(',')) {
      const to = range(segment);
      if (!to) break;
      const length = to.end - to.start + 1;
      if (offset < length) return to.start + offset;
      offset -= length;
    }
  }
  return null;
}

function episodeTarget(data, movie) {
  const targets = data[`anilist:${movie.anilistId}`] || {};
  const matches = [];
  for (const [descriptor, rules] of Object.entries(targets)) {
    const match = /^(tmdb_show|tmdb_movie):(\d+)(?::s(\d+))?$/.exec(descriptor);
    if (!match) continue;
    const episode = mappedEpisode(rules, movie.episode);
    if (!episode) continue;
    if (match[1] === 'tmdb_show' && match[3] !== undefined) matches.push({ id: match[2], season: +match[3], episode });
    if (match[1] === 'tmdb_movie') matches.push({ id: match[2] });
  }
  return matches.length === 1 ? matches[0] : null;
}

async function boundedText(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) throw new Error('Subtitle response too large.');
  let size = 0;
  const parts = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('Subtitle response too large.');
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts).toString('utf8');
}

class SubtitleSearch {
  constructor({ library, config, fetcher = fetch }) {
    this.library = library;
    this.config = config;
    this.fetch = fetcher;
    this.pending = new Map();
    this.results = new Map();
    this.mappingFile = path.join(path.dirname(library.root), 'anime-subtitle-mappings-v3.json');
  }

  configured() { return !!this.config.wyzieKey; }

  async mappings() {
    if (this.mappingTask) return this.mappingTask;
    this.mappingTask = (async () => {
      let cached;
      try {
        cached = JSON.parse(await fs.promises.readFile(this.mappingFile, 'utf8'));
        if (Date.now() - (await fs.promises.stat(this.mappingFile)).mtimeMs < 7 * 86400000) return cached;
      } catch {}
      try {
        const response = await this.fetch(MAPPINGS_URL, { signal: AbortSignal.timeout(25000) });
        if (!response.ok) throw new Error('mapping unavailable');
        const text = await boundedText(response, 32 * 1024 * 1024);
        const data = JSON.parse(text);
        if (!data['anilist:1']) throw new Error('invalid mappings');
        await fs.promises.mkdir(path.dirname(this.mappingFile), { recursive: true });
        await fs.promises.writeFile(this.mappingFile + '.tmp', text);
        await fs.promises.rename(this.mappingFile + '.tmp', this.mappingFile);
        return data;
      } catch {
        if (cached) return cached;
        throw new Error('Episode matching is temporarily unavailable. Try again later.');
      }
    })();
    try { return await this.mappingTask; } finally { this.mappingTask = null; }
  }

  async find(movie, lang) {
    if (movie?.kind !== 'anime' || !Number.isSafeInteger(movie.anilistId) || movie.anilistId < 1 ||
        !Number.isSafeInteger(movie.episode) || movie.episode < 1 || !/^[a-z]{2}$/.test(lang)) return { state: 'error', message: 'Invalid subtitle request.' };
    if (this.library.tracks(movie).some(t => t.lang === lang)) return { state: 'ready' };
    if (!this.configured()) return { state: 'setup', message: 'The host can enable automatic subtitle lookup in Settings → Anime subtitles.' };
    const key = `${movie.anilistId}:${movie.episode}:${movie.language}:${lang}`;
    if (this.pending.has(key)) return this.pending.get(key);
    const old = this.results.get(key);
    if (old && old.result.state !== 'ready' && old.key === this.config.wyzieKey && Date.now() - old.at < 300000) return old.result;
    // One episode and language at a time; callers share the same download across the party.
    if (this.pending.size >= 3) return { state: 'error', message: 'Subtitle lookup is busy. Try again shortly.' };
    const task = this.download(movie, lang).catch(() => ({ state: 'error', message: 'Subtitle lookup is temporarily unavailable. Try again in a few minutes.' }));
    this.pending.set(key, task);
    try {
      const result = await task;
      this.results.set(key, { result, at: Date.now(), key: this.config.wyzieKey });
      if (this.results.size > 200) this.results.delete(this.results.keys().next().value);
      return result;
    } finally { this.pending.delete(key); }
  }

  async download(movie, lang) {
    const target = episodeTarget(await this.mappings(), movie);
    if (!target) return { state: 'unavailable', message: 'No reliable episode match is available for subtitle lookup.' };
    const url = new URL('https://sub.wyzie.io/download');
    url.search = new URLSearchParams({ ...target, language: lang, to: 'vtt', source: 'all', key: this.config.wyzieKey });
    const response = await this.fetch(url.href, { signal: AbortSignal.timeout(45000), redirect: 'error' });
    if ([401, 403].includes(response.status)) return { state: 'setup', message: 'The host needs to check the subtitle provider key in Settings → Anime subtitles.' };
    if ([402, 429].includes(response.status)) return { state: 'error', message: 'The subtitle provider request limit has been reached. Try again after it resets.' };
    if ([400, 404, 422].includes(response.status)) return { state: 'unavailable', message: 'No matching text subtitles were found for this episode and language.' };
    if (!response.ok) throw new Error('provider unavailable');
    const text = (await boundedText(response, 2 * 1024 * 1024)).replace(/^\uFEFF/, '');
    if (!/^WEBVTT(?:\s|$)/.test(text) || !/(?:\d{2}:)?\d{2}:\d{2}\.\d{3}\s+-->\s+(?:\d{2}:)?\d{2}:\d{2}\.\d{3}/.test(text)) throw new Error('invalid captions');
    const dir = path.join(this.library.root, `anime-${movie.anilistId}`, movie.language === 'dub' ? 'dub' : 'sub');
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${movie.episode}.${lang}.auto.vtt`);
    // Serialize writes and eviction so concurrent language requests cannot exceed the cache cap.
    const write = async () => {
      await this.library.pruneAutomatic(20 * 1024 * 1024, Buffer.byteLength(text));
      await fs.promises.writeFile(file + '.tmp', text);
      await fs.promises.rename(file + '.tmp', file);
    };
    const task = (this.writeTask || Promise.resolve()).catch(() => {}).then(write);
    this.writeTask = task;
    await task;
    return { state: 'ready', message: 'Alternative subtitles are ready. Wording and timing may differ between releases.' };
  }
}

module.exports = { SubtitleSearch, episodeTarget, mappedEpisode };
