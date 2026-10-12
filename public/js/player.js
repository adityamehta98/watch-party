// Keeps the local <video> locked to the room's shared timeline.
// Every viewer plays the original file locally; this only nudges timing, it never touches quality.

import { PLATFORM } from './platform.js';
import { syncTuning } from './sync.js';

// iPhone / iPad (and Safari on a Mac): Safari's player doesn't like having its speed nudged up and
// down all the time (it re-buffers), and it reports time in coarse steps. So there we keep pace with
// small jumps every now and then instead, like the YouTube player, and tolerate a little more drift.
export const IS_APPLE = PLATFORM.appleMobile || PLATFORM.safari;
export const DEVICE = PLATFORM.device;
const APPLE_PROFILE = { hardSeek: 0.35, rate: false, nudge: 0.08, pausedEps: 0.2 };

export class SyncPlayer {
  constructor({ video, clock, onStatus, onBlocked, onChange }) {
    this.v = video;
    this.clock = clock;
    this.onStatus = onStatus;
    this.onBlocked = onBlocked;
    this.onChange = onChange || (() => {});
    this.movie = null;
    this.state = null;
    this.drift = 0;
    this.lastHardSeek = 0;
    this.seekLatency = 0.25;
    this.seekStartedAt = 0;
    this.startTimer = null;
    this.startTimerSeq = -1;
    this.playPending = false;
    this.blocked = false;
    this.autoMuted = false;
    this.lastStatusJson = '';
    this.lastStatusAt = 0;
    this.correctionId = 0;
    this.corrections = [];
    this.driftEma = 0;
    this.lastDriftAt = 0;
    this.lastRateCorrection = 0;
    this.lastRateDirection = 0;

    this.aligned = false;
    this.videoFailed = false;
    this.vfCheck = null;
    this.presented = 0;
    this.rvfcFor = null;
    this.sawPicture = false;
    this.badChecks = 0;
    this.handlers = null;
    this.attach(video);
    this.loop = setInterval(() => this.correct(), 200);
    this.videoLoop = setInterval(() => this.checkVideo(), 1000);
    document.addEventListener('visibilitychange', () => { this.vfCheck = null; this.badChecks = 0; });
    this.statusLoop = setInterval(() => this.report(false), 1000);
  }

  // Switch between the <video> element and an adapter (YouTube, streaming tab).
  attach(media) {
    if (this.handlers) for (const [ev, fn] of this.handlers) this.v.removeEventListener(ev, fn);
    this.v = media;
    if (!media.isAdapter && IS_APPLE && !media.syncProfile) media.syncProfile = APPLE_PROFILE;
    const on = (ev, fn) => { media.addEventListener(ev, fn); this.handlers.push([ev, fn]); };
    this.handlers = [];
    on('seeking', () => { this.seekStartedAt = performance.now(); this.vfCheck = null; });
    on('seeked', () => {
      if (this.seekStartedAt) {
        const took = (performance.now() - this.seekStartedAt) / 1000;
        this.seekLatency = Math.max(0.05, Math.min(1.5, this.seekLatency * 0.6 + took * 0.4));
      }
      this.seekStartedAt = 0;
      this.report(true);
    });
    for (const ev of ['waiting', 'playing', 'canplay', 'canplaythrough', 'pause', 'stalled', 'loadedmetadata', 'error']) {
      on(ev, () => { this.report(true); this.onChange(); });
    }
    // count the times playback ran dry (not our own seeks), so the host can see who keeps stalling and why
    // Only real stalls of the movie file count. YouTube and the streaming services report "buffering"
    // after every jump and at every start, which isn't a problem, and a jump we just made isn't a stall either.
    on('waiting', () => {
      if (media.isAdapter || media.seeking || !this.state || !this.state.playing) return;
      const t = performance.now();
      if (t - (this.seekStartedAt || 0) < 3000 || t - (this.lastHardSeek || 0) < 3000 || t - (this.playStartedAt || 0) < 3000) return;
      this.stalls = (this.stalls || 0) + 1;
    });
    on('playing', () => { if (!this.playStartedAt || performance.now() - this.playStartedAt > 60000) this.playStartedAt = performance.now(); });
    on('timeupdate', () => {
      this.onChange();
      // When you watch in a streaming tab, this page sits in a background tab where Chrome slows
      // timers to once a second (or once a minute after a while). Status updates from the streaming
      // tab still arrive instantly, so keep the sync running off those.
      if (media.isAdapter && document.hidden) {
        const t = performance.now();
        if (t - (this.lastCorrectAt || 0) > 600) this.correct(); // only when the regular 0.2 s loop has been slowed down
        if (t - (this.lastReportAt || 0) > 1000) { this.lastReportAt = t; this.report(false); }
      }
    });
    on('progress', () => this.onChange());
  }

  get profile() { return this.v.syncProfile || {}; }

  setMovie(movie, srcUrl, media) {
    if (media && media !== this.v) {
      if (this.v.isAdapter) this.v.close();
      else { try { this.v.pause(); this.v.removeAttribute('src'); this.v.load(); } catch {} }
      this.attach(media);
    }
    this.movie = movie;
    // HLS streams need a longer initial seek estimate (fetching + decoding a 4-10s segment).
    // The real latency is learned from the seeked event; this is just a starting guess.
    this.seekLatency = this.v.isAdapter ? 0.6 : (movie && movie.hls) ? 1.2 : 0.25;
    this.clearStart();
    this.drift = 0;
    this.aligned = false;
    this.lastHardSeek = 0;
    this.stalls = 0;
    this.corrections = [];
    this.driftEma = 0;
    this.lastDriftAt = 0;
    this.lastRateCorrection = 0;
    this.lastRateDirection = 0;
    this.videoFailed = false;
    this.vfCheck = null;
    this.sawPicture = false;
    this.badChecks = 0;
    const v = this.v;
    if (v.isAdapter) { if (movie) v.open(movie); else v.close(); this.onChange(); return; }
    for (const t of [...v.querySelectorAll('track')]) t.remove();
    if (!movie) { v.removeAttribute('src'); v.load(); this.onChange(); return; }
    if (srcUrl) v.src = typeof srcUrl === 'string' ? srcUrl : srcUrl.url;
    else v.removeAttribute('src');
    v.preload = 'auto';
    v.load();
    this.onChange();
  }

  setState(state) {
    const prev = this.state;
    // a new position from a play/seek/pause should be applied right away, not held back by the
    // "don't re-seek too often" guard that protects against buffering loops
    if (!prev || state.position !== prev.position || state.anchor !== prev.anchor || state.playing !== prev.playing) this.lastHardSeek = 0;
    this.state = state;
    this.correct();
    this.report(true);
  }

  expected(now = this.clock.now()) {
    const s = this.state;
    if (!s) return 0;
    let p = s.playing ? s.position + Math.max(0, now - s.anchor) / 1000 : s.position;
    if (this.movie && this.movie.duration) p = Math.min(p, this.movie.duration);
    return p;
  }

  clearStart() { clearTimeout(this.startTimer); this.startTimer = null; this.startTimerSeq = -1; }

  recordCorrection(type, drift = this.drift, value = null) {
    const now = performance.now();
    if (type === this.lastCorrectionType && now - (this.lastCorrectionAt || 0) < 500) return;
    this.lastCorrectionType = type;
    this.lastCorrectionAt = now;
    const item = { id: ++this.correctionId, type, drift: Math.round((Number(drift) || 0) * 1000), at: Math.round(this.clock.now()) };
    if (Number.isFinite(value)) item.value = Math.round(value * 1000) / 1000;
    this.corrections.push(item);
    if (this.corrections.length > 20) this.corrections.shift();
  }

  setRate(r) {
    const before = this.v.playbackRate || 1;
    if (Math.abs(before - r) <= 0.001) return;
    this.v.playbackRate = r;
    const direction = Math.sign(r - 1);
    const now = performance.now();
    if (!direction) this.lastRateDirection = 0;
    if (direction && (direction !== this.lastRateDirection || now - this.lastRateCorrection > 1500)) {
      this.lastRateDirection = direction;
      this.lastRateCorrection = now;
      this.recordCorrection('rate', this.drift, r);
    }
  }

  seekTo(t, type = 'seek') {
    const v = this.v;
    if (!isFinite(t)) return;
    this.lastHardSeek = performance.now();
    this.driftEma = 0;
    this.recordCorrection(type, this.drift, t);
    try { v.currentTime = Math.max(0, t); } catch { /* not ready */ }
  }

  tryPlay() {
    if (this.playPending) return;
    this.playPending = true;
    const p = this.v.play();
    if (!p) { this.playPending = false; return; }
    p.then(() => { this.blocked = false; })
      .catch(err => {
        if (err && err.name === 'NotAllowedError') {
          // Browser blocked sound before a click; play muted so the picture stays in sync.
          if (!this.v.muted) {
            this.v.muted = true;
            this.autoMuted = true;
            this.onBlocked && this.onBlocked('muted');
            return this.v.play().catch(() => { this.blocked = true; this.onBlocked && this.onBlocked('blocked'); });
          }
          this.blocked = true;
          this.onBlocked && this.onBlocked('blocked');
        }
      })
      .finally(() => { this.playPending = false; });
  }

  unblock() {
    this.blocked = false;
    if (this.autoMuted) { this.v.muted = false; this.autoMuted = false; }
    this.correct();
  }

  correct() {
    this.lastCorrectAt = performance.now();
    const v = this.v, s = this.state;
    if (!this.movie || !s || !v.src || v.readyState < 1) return;
    if (this.movie.browsing) return; // the host is still picking something on the service: leave the tabs alone
    if (!this.clock.synced) return; // wait until we know the room's clock, or a late joiner lands in the wrong place
    if (v.isAdapter && v.externalChangeAt && performance.now() - v.externalChangeAt < 1200) return;
    if (v.isAdapter && v.holdUntil && performance.now() < v.holdUntil) return; // the viewer is using the site's own controls
    const now = this.clock.now();

    const pausedEps = this.profile.pausedEps || 0.05; // how exact a paused frame must be
    if (!s.playing) {
      this.clearStart();
      if (!v.paused) v.pause();
      this.setRate(1);
      this.drift = v.currentTime - s.position;
      if (!v.seeking && Math.abs(this.drift) > pausedEps) this.seekTo(s.position, 'frame');
      else if (!v.seeking && !this.aligned) { this.aligned = true; this.onChange(); }
      return;
    }

    if (now < s.anchor) {
      // Scheduled start: park on the frame, then start at the same instant as everyone else.
      if (!v.paused) v.pause();
      this.setRate(1);
      if (!v.seeking && Math.abs(v.currentTime - s.position) > pausedEps) this.seekTo(s.position, 'schedule');
      if (this.startTimerSeq !== s.seq) {
        clearTimeout(this.startTimer);
        this.startTimerSeq = s.seq;
        this.startTimer = setTimeout(() => { this.startTimer = null; this.tryPlay(); }, Math.max(0, s.anchor - now));
      }
      return;
    }

    const target = this.expected(now);
    if (this.movie.duration && target >= this.movie.duration - 0.05) {
      if (!v.paused && v.ended) this.setRate(1);
      return;
    }
    if (v.seeking) return;

    const diff = v.currentTime - target;
    this.drift = diff;
    const driftNow = performance.now();
    this.driftEma = !this.lastDriftAt || driftNow - this.lastDriftAt > 1200 || Math.abs(diff - this.driftEma) > 0.5 ? diff : this.driftEma * 0.65 + diff * 0.35;
    this.lastDriftAt = driftNow;
    const sinceSeek = (performance.now() - this.lastHardSeek) / 1000;

    const prof = this.profile;
    const ahead = v.isAdapter ? null : this.bufferedAhead();
    const tuning = syncTuning({ drift: this.driftEma, ahead, rtt: this.clock.rtt || 0, profile: prof });
    const hardSeek = tuning.hardSeek;
    if (Math.abs(diff) > hardSeek) {
      // Far from the room (just joined, or fell behind): jump there first and only start playing once
      // we've arrived, so a late joiner never hears the movie from the beginning.
      // While waiting for data after a jump, don't keep re-seeking; it throws away buffer.
      if (!this.lastHardSeek || sinceSeek > 3 || (sinceSeek > 1.2 && v.readyState >= 3)) {
        if (!v.paused && !this.aligned) v.pause();
        this.seekTo(target + Math.min(this.seekLatency, 1), 'seek');
        this.setRate(1);
      }
      return;
    }
    if (v.paused && !this.blocked) this.tryPlay();
    // HLS gets a larger alignment window: the real drift keeps correcting itself with
    // the rate controller below, but the user shouldn't see "Catching up" forever.
    const alignEps = (this.movie && this.movie.hls) ? 0.8 : 0.3;
    if (!this.aligned && Math.abs(diff) < alignEps && !v.paused) { this.aligned = true; this.onChange(); }
    if (v.readyState < 3) { this.setRate(1); return; }
    if (prof.rate === false) {
      // this player can't change speed smoothly: instead, a small precise jump now and then (at most
      // every few seconds, and only when the buffer is healthy) keeps the sound in step
      const t = performance.now();
      if (this.nudgePending && !v.seeking && v.readyState >= 3 && t - this.lastNudge > 600) {
        // learn from where the last jump landed: too far ahead means we allowed too much for the seek
        this.nudgePending = false;
        this.nudgeComp = Math.max(0, Math.min(1, (this.nudgeComp == null ? this.seekLatency : this.nudgeComp) - diff * 0.8));
      }
      if (prof.nudge && Math.abs(diff) > prof.nudge && v.readyState >= 3 && t - (this.lastNudge || 0) > 4000 && sinceSeek > 2 && !this.nudgePending) {
        this.lastNudge = t;
        this.nudgePending = true;
        this.seekTo(this.expected(this.clock.now()) + (this.nudgeComp == null ? Math.min(this.seekLatency, 0.5) : this.nudgeComp), 'nudge');
      }
      return;
    }
    const controlDiff = this.driftEma;
    if (Math.abs(controlDiff) > tuning.softEps) {
      // bigger gaps (like right after someone else presses play) close faster, small ones gently
      const cap = tuning.maxRateDelta;
      const delta = Math.max(-cap, Math.min(cap, controlDiff * 0.8));
      this.setRate(1 - delta);
    } else {
      this.setRate(1);
    }
  }

  // Detects "sound plays but the picture stays black": the browser can't decode this video.
  // Careful not to cry wolf: Chrome stops drawing frames whenever the tab is hidden, minimized or
  // covered by another window, so we only judge while the page is visible, need two bad checks in
  // a row, and once real frames have shown up for this movie we stop suspecting the picture.
  watchFrames(v) {
    if (this.rvfcFor === v || !v.requestVideoFrameCallback) return;
    this.rvfcFor = v;
    const tick = () => { if (this.rvfcFor !== v) return; this.presented++; v.requestVideoFrameCallback(tick); };
    v.requestVideoFrameCallback(tick);
  }

  checkVideo() {
    const v = this.v;
    if (!this.movie || v.isAdapter) return;
    const visible = document.visibilityState === 'visible';
    if (!visible || v.paused || v.seeking || v.readyState < 3) { this.vfCheck = null; return; }
    this.watchFrames(v);
    const q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null;
    const frames = q ? q.totalVideoFrames : v.webkitDecodedFrameCount;
    if (!this.vfCheck) { this.vfCheck = { t: v.currentTime, frames: frames || 0, presented: this.presented }; return; }
    if (v.currentTime - this.vfCheck.t < 3) return;
    const decoded = (frames || 0) - this.vfCheck.frames;
    const shown = this.presented - this.vfCheck.presented;
    this.vfCheck = { t: v.currentTime, frames: frames || 0, presented: this.presented };
    if (shown > 5 || decoded > 5) this.sawPicture = true;
    // no picture at all: the video track has no size, or nothing was decoded or shown for a while
    const bad = v.videoWidth === 0 || (!this.sawPicture && shown === 0 && (frames == null || decoded === 0));
    this.badChecks = bad ? (this.badChecks || 0) + 1 : 0;
    const failed = this.badChecks >= 2;
    if (failed !== this.videoFailed) { this.videoFailed = failed; this.onChange(); this.report(true); }
  }

  get syncing() { return !!(this.movie && this.state && this.state.playing && !this.aligned); }

  bufferedAhead() {
    const v = this.v, t = v.currentTime, b = v.buffered;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.3 && b.end(i) >= t) return b.end(i) - t;
    return 0;
  }

  status() {
    const v = this.v, s = this.state;
    const loaded = !!this.movie && v.readyState >= 1;
    const now = this.clock.now();
    const intendPlaying = !!(s && s.playing && now >= s.anchor);
    const nearTarget = s ? Math.abs(v.currentTime - this.expected(now)) < 1.5 : false;
    const buffering = loaded && intendPlaying && (v.seeking || v.readyState < 3);
    const ahead = v.isAdapter ? null : Math.round(this.bufferedAhead() * 10) / 10;
    const health = !intendPlaying ? (loaded ? 100 : 0) : buffering ? 0 : ahead == null ? (v.readyState >= 3 ? 90 : 35) : Math.round(Math.max(0, Math.min(100, ahead / 12 * 100)));
    return {
      loaded,
      buffering,
      ready: loaded && this.clock.synced && v.readyState >= 3 && !v.seeking && nearTarget,
      blocked: this.blocked,
      ahead, health, rtt: Math.round(this.clock.rtt || 0),
      drift: Math.round(this.drift * 1000),
      seq: s ? s.seq : -1,
      error: v.error ? v.error.code : (this.videoFailed ? 98 : 0),
      stalls: this.stalls || 0, dev: DEVICE, rate: Math.round((v.playbackRate || 1) * 100) / 100,
      correction: this.corrections[this.corrections.length - 1] || null,
    };
  }

  report(force) {
    if (!this.movie || !this.state) return;
    const st = this.status();
    const key = JSON.stringify([st.loaded, st.buffering, st.ready, st.blocked, st.seq, st.error, st.correction && st.correction.id]);
    const now = performance.now();
    if (!force && key === this.lastStatusJson && now - this.lastStatusAt < 2000) return;
    if (force && key === this.lastStatusJson && now - this.lastStatusAt < 150) return;
    this.lastStatusJson = key;
    this.lastStatusAt = now;
    this.onStatus(st);
  }
}
