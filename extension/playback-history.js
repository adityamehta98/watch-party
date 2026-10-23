// Shared identity and durable, device-local progress. No account cookies or media URLs are stored.
var WPPlayback = (() => {
  const normalize = text => String(text || '').normalize('NFKC').toLowerCase()
    .replace(/['’‘`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  function asset(raw, service) {
    try {
      const u = new URL(raw);
      if (u.protocol !== 'https:' || wpServiceOf(u.hostname) !== service || u.username || u.password) return null;
      const patterns = {
        netflix: /^\/watch\/(\d+)\/?$/,
        prime: /\/(?:detail|dp)\/([A-Za-z0-9]+)(?:\/|$)/,
        hulu: /^\/watch\/([\w-]+)/,
        peacock: /\/watch\/playback\/[^/]+\/([\w-]+)/,
        crunchyroll: /^\/(?:\w{2}(?:-\w{2})?\/)?watch\/([\w-]+)/,
        paramount: /\/video\/([\w-]+)/,
        max: /\/(?:video|play|feature)\/watch\/([\w-]+)|\/video\/([\w-]+)/,
        disney: /\/(?:play|video)\/([\w-]+)/,
        appletv: /\/(?:movie|episode)\/[^/]+\/([\w.-]+)/,
      };
      const match = patterns[service]?.exec(u.pathname);
      if (!match) return null;
      return { assetId: match[1] || match[2], url: u.origin + u.pathname };
    } catch { return null; }
  }
  function key(service, title, meta = {}) {
    return `wp.progress.v1:${service}:${['movie', 'tv'].includes(meta.type) && Number.isSafeInteger(meta.tmdbId) && meta.tmdbId > 0
      ? `${meta.type}:${meta.tmdbId}` : `title:${normalize(title)}:${meta.year || ''}`}`;
  }
  function episode(text) {
    const match = /\bS(?:eason\s*)?(\d+)\s*[:·,\- ]*E(?:pisode\s*)?(\d+)\b/i.exec(text || '');
    return { season: match ? Number(match[1]) : null, episode: match ? Number(match[2]) : null };
  }
  function clean(entry, service) {
    if (!entry || !asset(entry.url, service) || asset(entry.url, service).assetId !== entry.assetId
      || !Number.isFinite(entry.position) || entry.position < 0 || !Number.isFinite(entry.duration) || entry.duration <= 0
      || !Number.isFinite(entry.lastWatched)) return null;
    return { ...entry, position: Math.min(entry.position, entry.duration),
      season: Number.isInteger(entry.season) && entry.season >= 0 ? entry.season : null,
      episode: Number.isInteger(entry.episode) && entry.episode > 0 ? entry.episode : null };
  }
  class History {
    constructor(storage, storageKey, service) { this.storage = storage; this.key = storageKey; this.service = service; this.entries = {}; this.queue = Promise.resolve(); }
    async load() {
      // A read failure must not turn existing progress into a fresh start.
      const data = (await this.storage.get(this.key))?.[this.key];
      for (const value of Object.values(data?.entries || {})) {
        const entry = clean(value, this.service);
        if (entry) this.entries[entry.assetId] = entry;
      }
      return Object.values(this.entries).sort((a, b) => b.lastWatched - a.lastWatched)[0] || null;
    }
    record(value) {
      const entry = clean(value, this.service);
      if (!entry) return Promise.resolve();
      this.entries[entry.assetId] = entry;
      const entries = Object.fromEntries(Object.values(this.entries).sort((a, b) => b.lastWatched - a.lastWatched).slice(0, 250).map(e => [e.assetId, e]));
      this.entries = entries;
      const snapshot = JSON.parse(JSON.stringify({ version: 1, entries }));
      this.queue = this.queue.catch(() => {}).then(() => this.storage.set({ [this.key]: snapshot }));
      return this.queue;
    }
  }
  return { normalize, asset, key, episode, History };
})();
if (typeof module !== 'undefined') module.exports = WPPlayback;
