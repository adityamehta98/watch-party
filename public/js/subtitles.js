const language = value => {
  const primary = String(value || '').trim().toLowerCase().split(/[-_]/)[0];
  return ({ english: 'en', eng: 'en', spanish: 'es', spa: 'es', japanese: 'ja', jpn: 'ja' })[primary] || primary;
};

export class SubtitleTracks {
  constructor(video, { preference = () => null, onChange = () => {}, onError = () => {} } = {}) {
    this.video = video;
    this.preference = preference;
    this.onChange = onChange;
    this.onError = onError;
    this.tracks = new Map();
    this.sources = new Map();
    this.statuses = new Map();
    this.retryId = 0;
    this.offset = 0;
    this.cueTimes = new WeakMap();
    this.selected = null;
    this.off = false;
    this.preferLocal = null;
    this.movieId = null;
    // Loading a new source (including an asynchronous HLS attachment) can reset Safari's modes.
    for (const event of ['loadedmetadata', 'loadeddata']) video.addEventListener(event, () => this.apply());
  }

  reset(movieId = null) {
    for (const track of this.tracks.values()) {
      track.track.mode = 'disabled';
      track.remove();
    }
    this.tracks.clear();
    this.sources.clear();
    this.statuses.clear();
    this.offset = 0;
    this.cueTimes = new WeakMap();
    this.selected = null;
    this.off = false;
    this.preferLocal = null;
    this.movieId = movieId;
  }

  add(movie, key) {
    if (this.movieId !== movie.id) this.reset(movie.id);
    const pref = this.preference();
    for (const sub of movie.subs || []) {
      if (this.tracks.has(sub.key)) continue;
      // Match labels as well: some providers omit the language on every episode.
      const failed = this.selected && this.status(this.selected) === 'error' ? this.sources.get(this.selected) : null;
      if (!this.off && sub.local && ((failed && language(sub.lang || sub.label) === language(failed.lang || failed.label)) || language(sub.lang) === this.preferLocal)) {
        this.selected = sub.key;
        this.preferLocal = null;
      }
      if (!this.off && !this.selected && pref && !/forced/i.test(sub.label) &&
          ((pref.lang && language(sub.lang || sub.label) === language(pref.lang)) ||
           (pref.label && sub.label.toLowerCase() === pref.label.toLowerCase()))) this.selected = sub.key;
      this.sources.set(sub.key, { ...sub, url: `${sub.url}${sub.url.includes('?') ? '&' : '?'}k=${encodeURIComponent(key)}` });
      this.create(sub.key);
    }
    this.apply();
  }

  select(key) {
    this.selected = this.tracks.has(key) ? key : null;
    this.off = !this.selected;
    if (this.selected && this.status(this.selected) === 'error') this.retry();
    this.apply();
  }

  status(key) { return this.statuses.get(key) || 'idle'; }

  setOffset(seconds) {
    this.offset = Math.max(-120, Math.min(120, Number(seconds) || 0));
    this.apply();
  }

  applyTiming(track) {
    for (const cue of track.track.cues || []) {
      if (!this.cueTimes.has(cue)) this.cueTimes.set(cue, { start: cue.startTime, end: cue.endTime });
      const original = this.cueTimes.get(cue);
      const start = Math.max(0, original.start + this.offset);
      const end = Math.max(start + 0.001, original.end + this.offset);
      if (start > cue.endTime) cue.endTime = end;
      cue.startTime = start;
      cue.endTime = end;
    }
  }

  create(key, retry = false) {
    const sub = this.sources.get(key);
    const track = this.video.ownerDocument.createElement('track');
    track.kind = 'subtitles';
    track.label = sub.label;
    const lang = language(sub.lang || sub.label);
    track.srclang = /^[a-z]{2,3}$/.test(lang) ? lang : 'und';
    track.src = sub.url + (retry ? `&_captionRetry=${++this.retryId}` : '');
    this.tracks.set(key, track);
    this.statuses.set(key, key === this.selected ? 'loading' : 'idle');
    track.addEventListener('load', () => {
      if (this.tracks.get(key) !== track) return;
      this.statuses.set(key, 'ready');
      this.apply();
    });
    track.addEventListener('error', () => {
      if (this.tracks.get(key) !== track) return;
      this.statuses.set(key, 'error');
      this.apply();
      if (this.selected === key) this.onError(sub);
    });
    // Set the default and mode before insertion, when Safari chooses its text tracks.
    track.default = key === this.selected;
    track.track.mode = key === this.selected ? 'showing' : 'disabled';
    this.video.appendChild(track);
  }

  retry() {
    const key = this.selected, old = this.tracks.get(key);
    if (!old) return;
    old.track.mode = 'disabled';
    old.remove();
    this.create(key, true);
    this.apply();
  }

  apply() {
    for (const [key, track] of this.tracks) {
      const selected = key === this.selected && this.status(key) !== 'error';
      // Safari needs a default track when captions are controlled by custom controls.
      if (track.default !== selected) track.default = selected;
      const mode = selected ? 'showing' : 'disabled';
      if (track.track.mode !== mode) track.track.mode = mode;
      if (selected && this.status(key) === 'ready') this.applyTiming(track);
      if (selected && this.status(key) === 'idle') this.statuses.set(key, 'loading');
    }
    this.onChange();
  }
}
