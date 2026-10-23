

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
  constructor(host) {
    super();
    this.host = host;          // element the player is placed in
    this.p = null;
    this.ready = false;
    this.state = -1;
    this.seekingTarget = null;
    this.seekStarted = 0;
    this._muted = false;
    this._volume = 1;
    // YouTube only supports a few fixed speeds, so the engine corrects drift with small jumps instead
    this.syncProfile = { hardSeek: 0.5, rate: false, pausedEps: 0.3 };
    this.poll = setInterval(() => this.tick(), 250);
  }

  async open(movie) {
    this.close();
    this.error = null;
    this.src = `yt:${movie.videoId}`;
    this.ready = false;
    try { await loadYouTubeApi(); } catch (e) { this.error = { code: 2, message: e.message }; this.emit('error'); return; }
    const div = document.createElement('div');
    this.host.innerHTML = '';
    this.host.appendChild(div);
    this.p = new window.YT.Player(div, {
      videoId: movie.videoId,
      width: '100%', height: '100%',
      playerVars: { controls: 0, disablekb: 1, rel: 0, playsinline: 1, modestbranding: 1, iv_load_policy: 3, fs: 0, autoplay: 0 },
      events: {
        onReady: () => {
          this.ready = true;
          if (this._muted) this.p.mute();
          this.p.setVolume(Math.round(this._volume * 100));
          this.emit('loadedmetadata'); this.emit('canplay');
        },
        onStateChange: e => this.onState(e.data),
        onError: e => { this.error = { code: 4, yt: e.data }; this.emit('error'); },
      },
    });
  }

  close() {
    if (this.p && this.p.destroy) { try { this.p.destroy(); } catch {} }
    this.p = null; this.ready = false; this.state = -1; this.src = '';
    if (this.host) this.host.innerHTML = '';
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

const MEGAPLAY_ORIGIN = 'https://megaplay.buzz';
const isMegaplayUrl = value => {
  try {
    const u = new URL(value);
    return u.origin === MEGAPLAY_ORIGIN && /^\/stream\/(?:s-2\/[^/]+\/(?:sub|dub)|(?:ani|mal)\/[^/]+\/[^/]+\/(?:sub|dub))\/?$/.test(u.pathname);
  } catch { return false; }
};
export class MegaplayMedia extends AdapterBase {
  constructor(host, { onUser, onFullscreen } = {}) {
    super();
    this.host = host;
    this.onUser = onUser || (() => {});
    this.onFullscreen = onFullscreen || (() => {});
    this.frame = null;
    this.ready = false;
    this.t = 0; this.dur = 0; this.tAt = 0;
    this.prevT = 0; this.prevAt = 0;
    this._playing = false;
    this.pausedOverride = null; this.overrideAt = 0;
    this.seekingTarget = null; this.seekStarted = 0;
    this._muted = false; this._volume = 1;
    this.buffering = false; this.pauseReported = false;
    // HLS behind the embed seeks slowly and the rate can't be set, so correct drift with occasional jumps.
    this.syncProfile = { hardSeek: 1.0, rate: false, pausedEps: 0.5 };
    this.onMsg = e => this.onMessage(e);
    window.addEventListener('message', this.onMsg);

    this.stallCheck = setInterval(() => this.checkStall(), 400);
  }

  checkStall() {
    if (!this.ready || this.seekingTarget != null || this.pausedOverride != null || !this._playing) return;
    const stalled = performance.now() - this.tAt;
    if (stalled > 1300 && !this.buffering) { this.buffering = true; this.emit('waiting'); }
    if (stalled > 3500 && !this.pauseReported) {
      this.pauseReported = true; this._playing = false; this.buffering = false;
      this.emit('pause'); this.userAction('pause', this.t);
    }
  }

  send(cmd) { try { this.frame && this.frame.contentWindow && this.frame.contentWindow.postMessage(cmd, MEGAPLAY_ORIGIN); } catch { /* not ready */ } }

  open(movie) {
    this.close();
    this.error = null;
    this.sources = [...new Set([...(Array.isArray(movie.sources) ? movie.sources : []), movie.url].filter(isMegaplayUrl))];
    this.sourceIndex = 0;
    if (!this.sources.length) {
      this.error = { code: 4, message: 'That episode has no valid MegaPlay embed.' };
      this.emit('error');
      return;
    }
    this.loadSource();
  }

  loadSource() {
    clearTimeout(this.readyTimer);
    this.ready = false; this._playing = false; this.prevAt = 0; this.buffering = false; this.pauseReported = false;
    const url = this.sources[this.sourceIndex];
    this.src = `mp:${url}`;
    const f = document.createElement('iframe');

    f.allow = 'autoplay; fullscreen; picture-in-picture; encrypted-media';
    f.allowFullscreen = true;
    f.frameBorder = '0';
    f.scrolling = 'no';

    f.referrerPolicy = 'origin';
    f.style.cssText = 'width:100%;height:100%;border:0;display:block';
    f.src = url;
    this.host.innerHTML = '';
    this.host.appendChild(f);
    this.frame = f;

    this.readyTimer = setTimeout(() => {
      if (!this.ready) {
        this.error = { code: 3, message: 'This episode did not start. Try another episode or language.' };
        this.emit('error');
      }
    }, 25000);
  }

  fsState(fs) { this.send({ megaFullscreenState: !!fs }); }

  failSource(message) {
    if (this.sourceIndex + 1 < this.sources.length) {
      this.sourceIndex++;
      this.loadSource();
      return;
    }
    clearTimeout(this.readyTimer);
    this.error = { code: 3, message };
    this.emit('error');
  }

  close() {
    clearTimeout(this.readyTimer);
    this.ready = false; this._playing = false; this.pausedOverride = null; this.seekingTarget = null;
    this.buffering = false; this.pauseReported = false;
    this.t = 0; this.dur = 0; this.tAt = 0; this.prevT = 0; this.prevAt = 0; this.src = '';
    this.externalChangeAt = 0; this.holdUntil = 0; this.lastUserAction = ''; this.lastUserAt = 0;
    this.sources = []; this.sourceIndex = 0;
    this.frame = null;
    if (this.host) this.host.innerHTML = '';
  }

  userAction(action, t) {
    const now = performance.now();
    if (action === this.lastUserAction && now - (this.lastUserAt || 0) < 500) return;
    this.lastUserAction = action; this.lastUserAt = now;

    this.externalChangeAt = now;
    this.holdUntil = now + 1600;
    this.onUser({ action, t });
  }

  onMessage(e) {
    if (!this.frame || e.source !== this.frame.contentWindow || e.origin !== MEGAPLAY_ORIGIN) return;
    let m = e.data;
    if (typeof m === 'string') { try { m = JSON.parse(m); } catch { return; } }
    if (!m || typeof m !== 'object') return;

    if (m.megaCommand === 'toggleFullscreen') { this.onFullscreen('toggle'); return; }
    if (m.megaCommand === 'getFullscreenState') { this.onFullscreen('get'); return; }
    if (m.event === 'time') {
      this.onTime(Number(m.time) || 0, Number(m.duration) || 0);
    } else if (m.type === 'watching-log') {
      this.onTime(Number(m.currentTime) || 0, Number(m.duration) || 0);
    } else if (m.event === 'complete') {
      if (this.dur > 0) this.t = this.dur;
      this.tAt = performance.now(); this._playing = false;
      this.emit('timeupdate'); this.emit('pause'); this.emit('ended');
    } else if (m.event === 'error') {
      this.failSource('MegaPlay could not load this episode. Try another episode or language.');
    } else if (m.event === 'PLAYER_READY') {
      if (!this.ready) { this.ready = true; clearTimeout(this.readyTimer); this.error = null; this.send({ cmd: 'SKP_DATA', auto: true }); this.emit('loadedmetadata'); this.emit('canplay'); }
    } else if (m.event === 'CURRENT_TIME') {
      this.onTime(Number(m.time) || 0, Number(m.duration) || 0);
    } else if (m.event === 'SEEK_DONE') {
      if (this.seekingTarget != null) { this.t = Number(m.value) || this.seekingTarget; this.tAt = performance.now(); this.seekingTarget = null; this.emit('seeked'); }
    }
  }

  onTime(t, dur) {
    const now = performance.now();
    const hadMeta = this.dur > 0;
    if (dur > 0) this.dur = dur;
    if (!this.ready) { this.ready = true; clearTimeout(this.readyTimer); this.error = null; this.send({ cmd: 'SKP_DATA', auto: true }); this.emit('loadedmetadata'); this.emit('canplay'); }
    // A progress report means the player is alive: if we had marked it buffering, it recovered.
    const wasBuffering = this.buffering;
    if (this.buffering) { this.buffering = false; this.emit('playing'); }
    this.pauseReported = false;

    if (this.seekingTarget == null && this.prevAt) {
      const elapsed = (now - this.prevAt) / 1000;
      if (elapsed > 0.15) {
        const moved = t - this.prevT;
        const commanded = this.pausedOverride != null;
        const expectedMove = this._playing ? elapsed : 0;
        const advancing = moved > 0.25 * elapsed;
        const steady = !wasBuffering && elapsed < 2.5; // not a buffer gap / catch-up
        const jumped = !commanded && steady && Math.abs(moved - expectedMove) > Math.max(3, elapsed * 1.5);
        if (jumped) this.userAction('seek', t);
        else if (advancing && !this._playing) {
          this._playing = true; this.emit('playing');
          if (!commanded) this.userAction('play', t);
        }
      }
    }
    this.prevT = t; this.prevAt = now;
    this.t = t; this.tAt = now;
    // our requested play/pause has taken effect (or timed out): stop forcing it
    if (this.pausedOverride != null && (this.pausedOverride === !this._playing || now - this.overrideAt > 2500)) this.pausedOverride = null;
    if (this.seekingTarget != null && (Math.abs(t - this.seekingTarget) < 1.5 || now - this.seekStarted > 6000)) { this.seekingTarget = null; this.emit('seeked'); }
    if (!hadMeta && this.dur > 0) this.emit('loadedmetadata');
    this.emit('timeupdate');
  }

  get readyState() { if (!this.ready) return 0; return this.buffering ? 2 : 4; }
  get paused() { return this.pausedOverride != null ? this.pausedOverride : !this._playing; }
  get seeking() { return this.seekingTarget != null; }
  get duration() { return this.dur || 0; }
  get currentTime() {
    if (this.seekingTarget != null) return this.seekingTarget;
    const since = performance.now() - this.tAt;

    const t = this.t + (this._playing && !this.buffering && since < 1300 ? since / 1000 : 0);
    return this.dur ? Math.min(t, this.dur) : t;
  }
  set currentTime(t) {
    this.seekingTarget = Math.max(0, t); this.seekStarted = performance.now();
    this.emit('seeking');
    this.send({ cmd: 'SEEK', value: this.seekingTarget });
  }
  get buffered() { return new TimeRangesLite(); }
  get playbackRate() { return 1; }
  set playbackRate(r) { /* ignored: the embed has no rate control */ }
  get muted() { return this._muted; }
  set muted(m) { m = !!m; if (m !== this._muted) { this._muted = m; this.send({ cmd: 'MUTE' }); this.emit('volumechange'); } }
  get volume() { return this._volume; }
  set volume(v) { this._volume = v; /* the embed exposes only mute, not a level */ }

  play() {
    this.pausedOverride = false; this.overrideAt = performance.now();
    if (!this._playing) { this._playing = true; this.send({ cmd: 'PLAY_TOGGLE' }); }
    this.buffering = false; this.pauseReported = false;
    return Promise.resolve();
  }
  pause() {
    this.pausedOverride = true; this.overrideAt = performance.now();
    if (this._playing) { this._playing = false; this.send({ cmd: 'PLAY_TOGGLE' }); }
    this.buffering = false;
  }
}

// ------------------------------------------------------------------ streaming tab via the extension
export class RemoteMedia extends AdapterBase {
  constructor({ onInfo } = {}) {
    super();
    this.onInfo = onInfo || (() => {});
    this.present = false;       // extension installed?
    this.version = null;
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
    if (e.source !== window || !e.data || e.data.source !== 'wp-ext') return;
    const m = e.data;
    if (m.type === 'hello') { this.present = true; this.version = m.version; this.platform = m.platform || 'chromium'; this.onInfo(); }
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
export const REQUIRED_EXT_VERSION = '1.15.0';
export const extOutdated = v => { const a = String(v || '0').split('.').map(Number), b = REQUIRED_EXT_VERSION.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((a[i] || 0) < b[i]) return true; if ((a[i] || 0) > b[i]) return false; } return false; };
export const SERVICE_HOSTS = {
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
