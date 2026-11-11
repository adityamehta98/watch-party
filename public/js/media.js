

class TimeRangesLite {
  constructor(ranges = []) { this.r = ranges; }
  get length() { return this.r.length; }
  start(i) { return this.r[i][0]; }
  end(i) { return this.r[i][1]; }
}

class AdapterBase extends EventTarget {
  constructor() {
    super();
    this.isAdapter = true;
    this.src = '';
    this.preload = 'auto';
    this.error = null;
    this.videoWidth = 1;
  }
  emit(type) { this.dispatchEvent(new Event(type)); }
  // no-op parts of the <video> API the engine touches
  load() {}
  removeAttribute() {}
  querySelectorAll() { return []; }
  canPlayType() { return ''; }
  get currentSrc() { return this.src; }
  get ended() { return !!this.duration && this.currentTime >= this.duration - 0.25; }
}

// ------------------------------------------------------------------ YouTube (in the page)
let ytApiPromise = null;
function loadYouTubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { if (prev) try { prev(); } catch {} resolve(); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { ytApiPromise = null; reject(new Error('Could not load YouTube')); };
    document.head.appendChild(s);
  });
  return ytApiPromise;
}

export class YouTubeMedia extends AdapterBase {
  constructor(host, { captionPreference = () => ({}), onCaptionsChange = () => {} } = {}) {
    super();
    this.host = host;          // element the player is placed in
    this.p = null;
    this.ready = false;
    this.state = -1;
    this.generation = 0;
    this.seekingTarget = null;
    this.seekStarted = 0;
    this._muted = false;
    this._volume = 1;
    this.captionPreference = captionPreference;
    this.onCaptionsChange = onCaptionsChange;
    this.captionTracks = [];
    this.captionsAvailable = null;
    this.captionsEnabled = false;
    this.captionLanguage = '';
    this.captionError = '';
    // YouTube only supports a few fixed speeds, so the engine corrects drift with small jumps instead
    this.syncProfile = { hardSeek: 0.5, rate: false, pausedEps: 0.3 };
    this.poll = setInterval(() => this.tick(), 250);
  }

  async open(movie) {
    this.close();
    this.error = null;
    this.src = `yt:${movie.videoId}`;
    this.ready = false;
    const captions = this.captionPreference() || {};
    this.captionsEnabled = captions.enabled === true;
    this.captionLanguage = String(captions.language || '');
    const generation = this.generation;
    try { await loadYouTubeApi(); } catch (e) { if (generation === this.generation) { this.error = { code: 2, message: e.message }; this.emit('error'); } return; }
    if (generation !== this.generation) return;
    const div = document.createElement('div');
    this.host.innerHTML = '';
    this.host.appendChild(div);
    this.p = new window.YT.Player(div, {
      videoId: movie.videoId,
      host: 'https://www.youtube-nocookie.com',
      width: '100%', height: '100%',
      playerVars: { controls: 0, disablekb: 1, rel: 0, playsinline: 1, iv_load_policy: 3, fs: 0, autoplay: 0,
        cc_load_policy: 1, ...(this.captionLanguage ? { cc_lang_pref: this.captionLanguage } : {}) },
      events: {
        onReady: () => {
          if (generation !== this.generation) return;
          this.ready = true;
          if (this._muted) this.p.mute();
          this.p.setVolume(Math.round(this._volume * 100));
          this.readCaptions();
          this.emit('loadedmetadata'); this.emit('canplay');
        },
        onApiChange: () => { if (generation === this.generation) this.readCaptions(); },
        onStateChange: e => { if (generation === this.generation) this.onState(e.data); },
        onError: e => { if (generation === this.generation) { this.error = { code: 4, yt: e.data }; this.emit('error'); } },
      },
    });
  }

  close() {
    this.generation++;
    if (this.p && this.p.destroy) { try { this.p.destroy(); } catch {} }
    this.p = null; this.ready = false; this.state = -1; this.src = '';
    this.captionTracks = []; this.captionsAvailable = null; this.captionError = '';
    this.captionApplied = '';
    this.onCaptionsChange();
    if (this.host) this.host.innerHTML = '';
  }

  readCaptions() {
    if (!this.ready || !this.p) return;
    try {
      const modules = this.p.getOptions?.() || [];
      if (modules.includes('captions')) {
        const active = this.p.getOption?.('captions', 'track');
        // YouTube may recreate its caption module after playback starts. Apply
        // Off again if it restored a track, even when our preference is unchanged.
        if (!this.captionsEnabled && active?.languageCode) this.captionApplied = '';
        const tracks = this.p.getOption?.('captions', 'tracklist');
        if (Array.isArray(tracks)) {
          this.captionTracks = tracks.filter(t => /^[a-zA-Z0-9-]{2,35}$/.test(t.languageCode || '')).map(t => ({
            language: t.languageCode, label: String(t.displayName || t.languageName || t.languageCode).slice(0, 100),
          }));
          this.captionsAvailable = this.captionTracks.length > 0;
        }
        this.applyCaptions();
      }
    } catch { this.captionError = 'YouTube captions are unavailable for this video.'; }
    this.onCaptionsChange();
  }

  setCaptions(enabled, language = this.captionLanguage) {
    this.captionsEnabled = !!enabled;
    this.captionLanguage = String(language || '');
    this.captionApplied = ''; this.captionError = '';
    if (this.ready) {
      try {
        if (enabled && !(this.p.getOptions?.() || []).includes('captions')) {
          if (typeof this.p.loadModule === 'function') this.p.loadModule('captions');
          else this.captionError = 'YouTube captions are unavailable for this video.';
        }
      } catch { this.captionError = 'YouTube captions are unavailable for this video.'; }
      this.readCaptions();
    }
    this.onCaptionsChange();
  }

  applyCaptions() {
    if (!this.p || !this.ready) return;
    const choice = this.captionsEnabled ? this.captionLanguage || 'auto' : 'off';
    if (this.captionApplied === choice) return;
    this.captionApplied = choice;
    if (!this.captionsEnabled) {
      // YouTube renders captions inside its iframe. Unload only that module;
      // changing caption preference must never reload or seek the video.
      this.p.setOption?.('captions', 'track', {});
      if (typeof this.p.unloadModule === 'function') this.p.unloadModule('captions');
    } else {
      const track = this.captionTracks.find(t => t.language === this.captionLanguage) || this.captionTracks[0];
      if (track) this.p.setOption?.('captions', 'track', { languageCode: track.language });
      this.p.setOption?.('captions', 'reload', true);
    }
  }

  onState(s) {
    const was = this.state;
    this.state = s;
    if (s === 1) { this.emit('playing'); if (this.seekingTarget != null) this.finishSeek(); }
    else if (s === 2) { this.emit('pause'); if (this.seekingTarget != null) this.finishSeek(); }
    else if (s === 3) this.emit('waiting');
    if (was !== s) this.emit('timeupdate');
  }

  finishSeek() { this.seekingTarget = null; this.emit('seeked'); }

  tick() {
    if (!this.ready) return;
    if (this.seekingTarget != null && performance.now() - this.seekStarted > 4000) this.finishSeek();
    this.emit('timeupdate');
  }

  get readyState() { if (!this.ready) return 0; return this.state === 3 ? 2 : 4; }
  get paused() { return !this.ready || this.state !== 1 && this.state !== 3; }
  get seeking() { return this.seekingTarget != null; }
  get duration() { return this.ready ? this.p.getDuration() || 0 : 0; }
  get currentTime() { return this.ready ? this.p.getCurrentTime() || 0 : 0; }
  set currentTime(t) {
    if (!this.ready) return;
    this.seekingTarget = t; this.seekStarted = performance.now();
    this.emit('seeking');
    this.p.seekTo(t, true);
  }
  get buffered() {
    if (!this.ready) return new TimeRangesLite();
    const d = this.duration, f = this.p.getVideoLoadedFraction ? this.p.getVideoLoadedFraction() : 0;
    return new TimeRangesLite(d ? [[0, d * f]] : []);
  }
  get playbackRate() { return 1; }
  set playbackRate(r) { /* ignored: YouTube only has fixed speeds */ }
  get muted() { return this._muted; }
  set muted(m) { this._muted = !!m; if (this.ready) (m ? this.p.mute() : this.p.unMute()); this.emit('volumechange'); }
  get volume() { return this._volume; }
  set volume(v) { this._volume = v; if (this.ready) this.p.setVolume(Math.round(v * 100)); this.emit('volumechange'); }

  play() {
    if (!this.ready) return Promise.reject(new Error('not ready'));
    this.p.playVideo();
    return new Promise((resolve, reject) => {
      const t0 = performance.now();
      const check = () => {
        if (this.state === 1 || this.state === 3) return resolve();
        if (performance.now() - t0 > 1800) { const e = new Error('blocked'); e.name = 'NotAllowedError'; return reject(e); }
        setTimeout(check, 100);
      };
      check();
    });
  }
  pause() { if (this.ready) this.p.pauseVideo(); }
}

// ------------------------------------------------------------------ streaming tab via the extension
export class RemoteMedia extends AdapterBase {
  constructor({ onInfo } = {}) {
    super();
    this.onInfo = onInfo || (() => {});
    this.present = false;       // extension installed?
    this.version = null;
    this.versionVerified = false;
    this.canSettings = false;
    this.access = null;
    this.canUpdate = false;
    this.updateRequests = new Map();
    this.updateSequence = 0;
    this.st = null;             // last status from the streaming tab
    this.stAt = 0;
    this.linked = false;
    this.movie = null;
    this.seekingTarget = null;
    this.seekStarted = 0;
    this.pausedOverride = null; // what we just asked for, until the tab confirms
    this.lastRateSent = 1;
    this.lastRateAt = 0;
    this._volume = 1;
    this._muted = false;
    // streaming sites take a moment to jump (they fetch encrypted segments), so correct gently
    this.syncProfile = { hardSeek: 1.5, rate: true, softEps: 0.08, pausedEps: 0.5 };
    window.addEventListener('message', e => this.onMessage(e));
    this.post({ type: 'ping' });
    setInterval(() => {
      if (this.linked && performance.now() - this.stAt > 4000 && this.st) { this.st = null; this.emit('waiting'); this.onInfo(); }
    }, 1000);
  }

  post(msg) { window.postMessage({ source: 'wp-page', ...msg }, location.origin); }

  onMessage(e) {
    if (e.source !== window || e.origin !== location.origin || !e.data || e.data.source !== 'wp-ext') return;
    const m = e.data;
    if (m.type === 'hello') {
      // An old content script can outlive an extension reload. Its cached hello
      // must not replace metadata verified by the active background worker.
      if (this.versionVerified && !m.verified) return;
      if (this.versionVerified && m.verified && extOutdated(m.version, this.version)) return;
      this.present = true; this.version = m.version; this.versionVerified = m.verified === true;
      this.canUpdate = m.updates === true; this.canSettings = m.settings === true;
      this.extensionId = m.extensionId || this.extensionId;
      this.onInfo();
      if (!this.versionVerified && !this.infoRequested) { this.infoRequested = true; this.post({ type: 'extension-info' }); }
    }
    else if (m.type === 'service-access') { this.access = m; this.onInfo(); }
    else if (m.type === 'extension-update-result' || m.type === 'extension-settings-result') {
      const request = this.updateRequests.get(m.id);
      if (request) { clearTimeout(request.timer); this.updateRequests.delete(m.id); request.resolve(m.result || { status: 'error' }); }
    }
    else if (m.type === 'catalog-launch-result') { if (this.movie?.launchId === m.id) this.onLaunchResult?.(m); }
    else if (m.type === 'ext-problem') { this.onProblem && this.onProblem(m); }
    else if (m.type === 'linked') {
      this.linked = true; this.linkInfo = m; this.onInfo();
      // a newly linked tab gets the party's level right away
      this.cmd({ op: 'volume', v: this._volume }); if (this._muted) this.cmd({ op: 'mute', m: true });
    }
    else if (m.type === 'unlinked') { this.linked = false; this.st = null; this.emit('waiting'); this.onInfo(); }
    else if (m.type === 'status') this.onStatus(m.st);
    else if (m.type === 'user' && m.action === 'volume') {
      // the viewer changed the level with the site's own slider or keys: the party follows
      const v = Number(m.vol);
      if (Number.isFinite(v)) this._volume = Math.max(0, Math.min(1, v));
      this._muted = !!m.muted;
      this.emit('volumechange');
      this.onUserVolume && this.onUserVolume(this._volume, this._muted);
    }
    else if (m.type === 'user') {
      // the viewer just used the site's own controls: the tab is where they want it, don't pull it back
      this.holdUntil = Math.max(this.holdUntil || 0, performance.now() + 1500);
      if (m.url && this.st && this.st.url && canonicalUrl(m.url) !== canonicalUrl(this.st.url)) this.urlChangedAt = performance.now();
      if (this.st && m.action === 'seek' && Number.isFinite(Number(m.t))) { this.st = { ...this.st, t: Number(m.t) }; this.stAt = performance.now(); }
      this.onUser && this.onUser(m);
    }
    else if (m.type === 'page') { this.page = { url: m.url, signin: !!m.signin, at: performance.now() }; if (m.url) this.lastUrl = m.url; this.onPage && this.onPage(this.page); }
    else if (m.type === 'dock-state' || m.type === 'ui-action' || m.type === 'dock-rtc') this.onDock && this.onDock(m);
  }

  onStatus(st) {
    const prev = this.st;
    const hadMeta = prev && prev.dur;
    const prevAt = this.stAt;
    this.st = st;
    if (st.url) this.lastUrl = st.url;
    this.stAt = performance.now();
    this.linked = true;

    const now = performance.now();
    if (prev && prev.paused !== st.paused && this.pausedOverride == null) this.externalChangeAt = now;

    if (st.hold) this.holdUntil = Math.max(this.holdUntil || 0, now + 1200);
    if (prev && this.seekingTarget == null && !st.ad && !prev.ad) {
      const moving = !prev.paused && !prev.buffering;
      const guess = prev.t + (moving ? (now - prevAt) / 1000 * (prev.rate || 1) : 0);
      if (Math.abs(st.t - guess) > 2.5) this.holdUntil = Math.max(this.holdUntil || 0, now + 1500);
    }
    if (prev && prev.url && st.url && canonicalUrl(prev.url) !== canonicalUrl(st.url)) { this.holdUntil = Math.max(this.holdUntil || 0, now + 5000); this.urlChangedAt = now; }
    if (this.pausedOverride != null && st.paused === this.pausedOverride) this.pausedOverride = null;
    if (this.pausedOverride != null && performance.now() - this.overrideAt > 2500) this.pausedOverride = null;
    if (this.seekingTarget != null && ((Math.abs(st.t - this.seekingTarget) < 2 && !st.buffering) || performance.now() - this.seekStarted > 6000)) {
      this.seekingTarget = null; this.emit('seeked');
    }
    if (!prev) { this.emit('loadedmetadata'); this.emit('canplay'); }
    if (prev && prev.paused !== st.paused) this.emit(st.paused ? 'pause' : 'playing');
    if (prev && !prev.buffering && st.buffering) this.emit('waiting');
    if (prev && prev.buffering && !st.buffering) this.emit('playing');
    this.emit('timeupdate');
    if (!hadMeta && st.dur || !prev || prev.title !== st.title || prev.ad !== st.ad || prev.blocked !== st.blocked) this.onInfo();
  }

  open(movie) {
    this.movie = movie;
    this.src = `ext:${movie.service}`;
    this.st = null;
    this.seekingTarget = null;
    this.post({ type: 'watch', service: movie.service, url: movie.url, launchTitle: movie.launchTitle || '', launchId: movie.launchId || movie.id, playbackRef: movie.playbackRef || null, blockPopups: movie.strict !== false });
  }
  close() { this.movie = null; this.src = ''; this.st = null; this.post({ type: 'unwatch' }); }
  openTab() { if (this.movie) this.post({ type: 'open', service: this.movie.service, url: this.movie.url }); }
  showTab() { this.post({ type: 'show' }); }
  navigate(url) { this.post({ type: 'navigate', url }); }
  advance(url) { this.cmd({ op: 'next', url }); }
  // the page the streaming tab is on (kept across title changes, which clear the rest of the status)
  get pageUrl() { return this.lastUrl || (this.st && this.st.url) || ''; } // the freshest: status and page reports both update lastUrl
  get signingIn() { return !!(this.page && this.page.signin && performance.now() - this.page.at < 8000); }
  openPanel() { this.post({ type: 'open-panel' }); }
  updateExtension(op, required, { passive = false } = {}) {
    if (!this.canUpdate) return Promise.resolve({ status: 'manual' });
    return this.extensionRequest('extension-update', { op, required, passive }, 46000);
  }
  openSettings() { return this.extensionRequest('extension-settings', {}, 3000); }
  checkAccess() { this.post({ type: 'extension-info' }); }
  extensionRequest(type, fields, timeout) {
    const id = ++this.updateSequence;
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.updateRequests.delete(id); resolve({ status: 'error', error: 'The extension did not respond. Reload this page and try again.' }); }, timeout);
      this.updateRequests.set(id, { resolve, timer });
      this.post({ type, id, ...fields });
    });
  }
  overlay(item) { if (this.linked) this.post({ type: 'overlay', item }); }
  cmd(c) { this.post({ type: 'cmd', cmd: c }); }

  get readyState() {
    if (!this.st || performance.now() - this.stAt > 4000) return 0;
    return (this.st.buffering || this.st.ad) ? 2 : 4;
  }
  get paused() { return this.pausedOverride != null ? this.pausedOverride : (!this.st || this.st.paused); }
  get seeking() { return this.seekingTarget != null; }
  get duration() { return (this.st && this.st.dur) || 0; }
  get currentTime() {
    if (!this.st) return 0;
    if (this.seekingTarget != null) return this.seekingTarget;
    const moving = !this.st.paused && !this.st.buffering && !this.st.ad;
    return this.st.t + (moving ? (performance.now() - this.stAt) / 1000 * (this.st.rate || 1) : 0);
  }
  set currentTime(t) {
    this.seekingTarget = t; this.seekStarted = performance.now();
    this.emit('seeking');
    this.cmd({ op: 'seek', t });
  }
  get buffered() { return new TimeRangesLite(); }
  get playbackRate() { return this.lastRateSent; }
  set playbackRate(r) {
    // don't flood the tab with tiny changes; streaming players dislike constant rate changes
    const now = performance.now();
    if (Math.abs(r - this.lastRateSent) < 0.01 && r !== 1) return;
    if (r !== 1 && now - this.lastRateAt < 500) return;
    this.lastRateSent = r; this.lastRateAt = now;
    this.cmd({ op: 'rate', r });
  }
  get muted() { return this._muted; }
  set muted(m) { this._muted = !!m; this.cmd({ op: 'mute', m: !!m }); this.emit('volumechange'); }
  get volume() { return this._volume; }
  set volume(v) { this._volume = v; this.cmd({ op: 'volume', v }); this.emit('volumechange'); }
  get blockedInTab() { return !!(this.st && this.st.blocked); }

  play() {
    this.pausedOverride = false; this.overrideAt = performance.now();
    this.cmd({ op: 'play' });
    return Promise.resolve();
  }
  pause() {
    this.pausedOverride = true; this.overrideAt = performance.now();
    this.cmd({ op: 'pause' });
  }
}

// Which service a link belongs to (keep in sync with server/services.js and the extension).
export const SERVICE_NAMES = {
  youtube: 'YouTube', netflix: 'Netflix', prime: 'Prime Video', hulu: 'Hulu', peacock: 'Peacock',
  crunchyroll: 'Crunchyroll', paramount: 'Paramount+', max: 'Max', disney: 'Disney+', appletv: 'Apple TV+',
};
// Where each service starts (sign in, then pick something). YouTube is different: it plays right in the page.
export const SERVICE_HOMES = {
  netflix: 'https://www.netflix.com/browse', prime: 'https://www.primevideo.com/', hulu: 'https://www.hulu.com/hub/home',
  peacock: 'https://www.peacocktv.com/watch/home', crunchyroll: 'https://www.crunchyroll.com/', paramount: 'https://www.paramountplus.com/home/',
  max: 'https://play.max.com/', disney: 'https://www.disneyplus.com/home', appletv: 'https://tv.apple.com/',
};
// Search deep-links per service: opens the service at a search for the title; the host then picks it and the room follows.
export const SERVICE_SEARCH = {
  netflix: q => `https://www.netflix.com/search?q=${q}`,
  prime: q => `https://www.primevideo.com/search?phrase=${q}`,
  hulu: q => `https://www.hulu.com/search?q=${q}`,
  peacock: q => `https://www.peacocktv.com/watch/search?q=${q}`,
  crunchyroll: q => `https://www.crunchyroll.com/search?q=${q}`,
  paramount: q => `https://www.paramountplus.com/search/?query=${q}`,
  max: q => `https://play.max.com/search?q=${q}`,
  disney: q => `https://www.disneyplus.com/search?q=${q}`,
  appletv: q => `https://tv.apple.com/search?term=${q}`,
};
// The extension version this page was built for (the build checks it matches extension/manifest.json).
export const LATEST_EXT_VERSION = '1.17.15';
// Updater-only releases must not prevent compatible Netflix players from opening.
export const REQUIRED_EXT_VERSION = '1.17.8';
export const extOutdated = (v, required = REQUIRED_EXT_VERSION) => { const a = String(v || '0').split('.').map(Number), b = required.split('.').map(Number); for (let i = 0; i < 4; i++) { if ((a[i] || 0) < b[i]) return true; if ((a[i] || 0) > b[i]) return false; } return false; };
const SERVICE_HOSTS = {
  youtube: ['youtube.com', 'youtu.be'], netflix: ['netflix.com'], prime: ['primevideo.com', 'amazon.com'], hulu: ['hulu.com'], peacock: ['peacocktv.com'],
  crunchyroll: ['crunchyroll.com'], paramount: ['paramountplus.com'], max: ['max.com', 'hbomax.com'], disney: ['disneyplus.com'], appletv: ['tv.apple.com'],
};
// Same rules as the extension's wpCanonicalUrl and the server's services.identify.
export function canonicalUrl(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch { return ''; }
  const svc = serviceOfUrl(u.toString());
  if (!svc) {
    // any other website (the host's custom site): the page itself, query included
    if (!/^https?:$/.test(u.protocol)) return '';
    return `https://${u.hostname.toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  }
  u.hash = '';
  if (svc === 'youtube') { const v = u.searchParams.get('v'); u.search = v ? `?v=${v}` : ''; } else u.search = '';
  let p = u.pathname.replace(/\/ref=[^/]*$/, '').replace(/\/+$/, '');
  if (svc === 'netflix') { const m = /\/watch\/(\d+)/.exec(p); if (m) p = `/watch/${m[1]}`; }
  return `https://${u.hostname.toLowerCase()}${p || '/'}${u.search}`;
}

const NOT_A_TITLE = /^\/(?:$|browse|home|hub|search|profiles?|login|signin|sign-in|signup|account|settings|my-?stuff|my-?list|watchlist|collections?|genres?|categories|storefront|kids|title|welcome)(?:\/|$)/i;
export function isTitlePage(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch { return false; }
  const svc = serviceOfUrl(u.toString());
  if (!svc) return /^https?:$/.test(u.protocol); // a custom site: any page of it
  const p = u.pathname.replace(/^\/[a-z]{2}(?:-[a-z]{2})?(?=\/)/i, ''); // a language/country prefix (/us/..., /en-gb/...)
  const home = x => NOT_A_TITLE.test(x) || /^\/(?:watch\/home|region\/[^/]+\/storefront|gp\/video\/storefront|video\/storefront)/i.test(x);
  if (home(p) || home(u.pathname)) return false;
  if (svc === 'netflix') return /^\/watch\/\d+/.test(p);
  return true;
}
export const serviceOfUrl = url => { try { const h = new URL(url).hostname.toLowerCase(); return Object.keys(SERVICE_HOSTS).find(id => SERVICE_HOSTS[id].some(x => h === x || h.endsWith('.' + x))) || null; } catch { return null; } };
export const SERVICE_COLORS = {
  youtube: '#ff0033', netflix: '#e50914', prime: '#1399ff', hulu: '#1ce783', peacock: '#f5c518', crunchyroll: '#f47521',
  paramount: '#0064ff', max: '#002be7', disney: '#0e3fd8', appletv: '#a2aaad',
};
