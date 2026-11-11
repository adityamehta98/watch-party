'use strict';

const fs = require('fs');
const { cleanPlayback } = require('./playback-history');

function cleanPoster(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && /(^|\.)anilist\.co$/.test(url.hostname) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

// Store episode metadata and observed playback only. Stream URLs expire and must be resolved again.
class AnimeHistory {
  constructor(file, { onError = error => console.warn('Could not save anime history:', error.message) } = {}) {
    this.file = file;
    this.onError = onError;
    this.entries = new Map();
    this.playbackEntries = new Map();
    this.hiddenAnime = new Set();
    this.dirty = false;
    this.timer = null;
    this.updatedAt = 0;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(data.episodes)) throw new Error('Invalid anime history');
      for (const value of Array.isArray(data.playback) ? data.playback : []) {
        const entry = cleanPlayback(value);
        if (entry) this.playbackEntries.set(entry.id, entry);
      }
      for (const id of Array.isArray(data.hiddenAnime) ? data.hiddenAnime : []) {
        if (Number.isSafeInteger(id) && id > 0) this.hiddenAnime.add(id);
      }
      for (const value of data.episodes) {
        const entry = this.clean(value);
        if (entry) {
          this.entries.set(this.key(entry.anilistId, entry.episode), entry);
          this.updatedAt = Math.max(this.updatedAt, entry.updatedAt);
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.onError(error);
    }
  }

  key(id, episode) { return `${id}:${episode}`; }
  get(id, episode) { return this.entries.get(this.key(id, episode)); }
  list() { return [...this.entries.values()].sort((a, b) => b.updatedAt - a.updatedAt); }
  hidden() { return [...this.hiddenAnime]; }

  playbackList() { return [...this.playbackEntries.values()].sort((a, b) => b.updatedAt - a.updatedAt); }
  importPlayback(values) {
    let changed = false;
    for (const value of values.slice(0, 500)) {
      const entry = cleanPlayback(value), old = entry && this.playbackEntries.get(entry.id);
      if (!entry || !entry.position || old) continue;
      this.playbackEntries.set(entry.id, entry); changed = true;
    }
    if (changed) { this.schedule(); this.flush(); }
    return changed;
  }
  recordPlayback(movie, position, duration) {
    const entry = cleanPlayback({ ...movie, position, duration, updatedAt: Date.now() });
    if (!entry || !position) return false;
    const old = this.playbackEntries.get(entry.id);
    entry.hidden = !!old?.hidden;
    if (old?.url === entry.url && old?.netflix) entry.netflix = old.netflix;
    if (old && old.position === entry.position && old.duration === entry.duration && old.title === entry.title) return false;
    this.playbackEntries.set(entry.id, entry);
    const keep = this.playbackList().slice(0, 500);
    this.playbackEntries = new Map(keep.map(item => [item.id, item]));
    this.schedule();
    return true;
  }
  setNetflixMetadata(id, url, netflix) {
    const entry = this.playbackEntries.get(id);
    if (entry?.service !== 'netflix' || entry.url !== url) return false;
    const updated = cleanPlayback({ ...entry, netflix });
    if (!updated?.netflix || JSON.stringify(entry.netflix) === JSON.stringify(updated.netflix)) return false;
    this.playbackEntries.set(id, updated); this.schedule(); this.flush(); return true;
  }
  dismissPlayback(id) {
    const entry = this.playbackEntries.get(id);
    if (!entry || entry.hidden) return false;
    entry.hidden = true; this.schedule(); this.flush(); return true;
  }

  dismiss(id) {
    if (!Number.isSafeInteger(id) || !this.list().some(entry => entry.anilistId === id) || this.hiddenAnime.has(id)) return false;
    this.hiddenAnime.add(id);
    this.schedule();
    this.flush();
    return true;
  }

  restore(id) {
    if (!this.hiddenAnime.delete(id)) return false;
    this.schedule();
    this.flush();
    return true;
  }

  clean(value) {
    if (!value || !Number.isSafeInteger(value.anilistId) || value.anilistId <= 0
      || !Number.isInteger(value.episode) || value.episode < 1 || value.episode > 100000) return null;
    const duration = Number.isFinite(value.duration) && value.duration > 0 ? Math.min(value.duration, 86400) : 0;
    const position = Number.isFinite(value.position) && value.position >= 0 ? Math.min(value.position, duration || 86400) : 0;
    return {
      anilistId: value.anilistId, malId: Math.max(0, Math.trunc(Number(value.malId)) || 0),
      episode: value.episode, episodes: Math.max(0, Math.min(100000, Math.trunc(Number(value.episodes)) || 0)),
      animeTitle: String(value.animeTitle || 'Anime').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 120),
      poster: cleanPoster(value.poster),
      language: value.language === 'dub' ? 'dub' : 'sub', position, duration,
      completed: value.completed === true,
      updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
    };
  }

  record(meta, position, duration, ended = false) {
    if (!Number.isFinite(position) || position < 0 || !Number.isFinite(duration) || duration < 0) return false;
    const old = this.get(meta.anilistId, meta.episode);
    const poster = cleanPoster(meta.poster) || old?.poster || this.list().find(entry => entry.anilistId === meta.anilistId && entry.poster)?.poster || '';
    const entry = this.clean({ ...meta, poster, position, duration: duration || old?.duration || 0,
      completed: !!old?.completed || (duration > 0 && (position / duration >= 0.9 || (ended && position >= duration - 1))),
      updatedAt: Math.max(Date.now(), this.updatedAt + 1) });
    if (!entry) return false;
    if (old && ['position', 'duration', 'completed', 'language', 'animeTitle', 'episodes', 'malId', 'poster'].every(k => old[k] === entry[k])) return false;
    this.entries.set(this.key(entry.anilistId, entry.episode), entry);
    this.updatedAt = entry.updatedAt;
    this.schedule();
    return true;
  }

  mark(id, episode, completed) {
    const old = this.get(id, episode);
    if (!old || typeof completed !== 'boolean') return false;
    this.updatedAt = Math.max(Date.now(), this.updatedAt + 1);
    this.entries.set(this.key(id, episode), { ...old, completed, position: completed ? old.position : 0, updatedAt: this.updatedAt });
    this.schedule();
    this.flush();
    return true;
  }

  setPoster(id, value) {
    const poster = cleanPoster(value);
    if (!poster) return false;
    let changed = false;
    for (const [key, entry] of this.entries) {
      if (entry.anilistId !== id || entry.poster === poster) continue;
      this.entries.set(key, { ...entry, poster });
      changed = true;
    }
    if (changed) this.schedule();
    return changed;
  }

  schedule() {
    this.dirty = true;
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), 5000);
      this.timer.unref?.();
    }
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty) return;
    try {
      fs.writeFileSync(this.file + '.tmp', JSON.stringify({ version: 3, episodes: this.list(), hiddenAnime: this.hidden(), playback: this.playbackList() }));
      fs.renameSync(this.file + '.tmp', this.file);
      this.dirty = false;
    } catch (error) { this.onError(error); }
  }
}

module.exports = { AnimeHistory };
