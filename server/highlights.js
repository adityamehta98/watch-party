'use strict';
// Highlights: finds notable moments from loudness spikes (ffmpeg ebur128) and chat / reaction spikes,
// then cuts short shareable clips with ffmpeg. Started by the host; nothing runs otherwise.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { serveFile } = require('./media');

const SUPPORTED = new Set(['file', 'anime', 'catalog']);
const MAX_MOMENTS = 8;
const MIN_GAP = 20;          // seconds between two moments
const THRESHOLD = 1.5;       // standard deviations above the movie's own average
const CLIP_BEFORE = 5, CLIP_AFTER = 5;
const MAX_ANALYSIS = 4 * 3600;
const redact = text => String(text || '').replace(/([?&]k=)[^&\s"']+/g, '$1[private]');

function ffmpegRun(ffmpeg, args, { timeoutMs = 600000, onLine, hls = false } = {}) {
  const run = picky => new Promise((resolve, reject) => {
    const full = ['-hide_banner', '-nostdin', ...(hls && picky ? ['-extension_picky', '0'] : []), ...args];
    const proc = spawn(ffmpeg, full, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    ffmpegRun.running.add(proc);
    let rest = '', tail = '';
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
    proc.stderr.on('data', d => {
      const text = rest + d;
      const lines = text.split(/\r?\n|\r/);
      rest = lines.pop();
      for (const line of lines) { if (onLine) onLine(line); tail = (tail + line + '\n').slice(-2000); }
    });
    proc.on('error', e => { clearTimeout(timer); ffmpegRun.running.delete(proc); reject(e); });
    proc.on('close', code => {
      clearTimeout(timer); ffmpegRun.running.delete(proc);
      if (rest) { if (onLine) onLine(rest); tail += rest; }
      if (code === 0) return resolve();
      if (hls && picky && /extension_picky/.test(tail)) return run(false).then(resolve, reject);
      reject(new Error(redact(tail).trim().split(/\r?\n/).pop() || `ffmpeg exit ${code}`));
    });
  });
  return run(true);
}
ffmpegRun.running = new Set();

// "[Parsed_ebur128_0 @ ...] t: 1.2  TARGET:-23 LUFS  M: -21.4 S: ..." -> { t, lufs }
function parseEbur128Line(line) {
  const m = /\bt:\s*([\d.]+)\s+TARGET:.*?\bM:\s*(-?[\d.]+|-?inf|nan)/i.exec(line);
  if (!m) return null;
  const lufs = Number(m[2]);
  return { t: Number(m[1]), lufs: Number.isFinite(lufs) ? lufs : -70 };
}

// Momentary loudness of each second in [start, end), streamed from ffmpeg's log line by line.
async function loudnessSeries(ffmpeg, input, start, end, { hls = false } = {}) {
  const series = [];
  await ffmpegRun(ffmpeg, ['-nostats', '-ss', String(start), '-i', input, '-t', String(end - start), '-map', '0:a:0', '-vn', '-sn', '-dn',
    '-af', 'ebur128', '-f', 'null', '-'], { hls, onLine: line => {
    const point = parseEbur128Line(line);
    if (!point) return;
    const s = Math.floor(start + point.t);
    series[s] = Math.max(series[s] ?? -70, Math.max(-70, point.lufs));
  } });
  return series;
}

function zScores(values) {
  const n = values.length;
  if (!n) return [];
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  return std > 1e-9 ? values.map(v => (v - mean) / std) : values.map(() => 0);
}
function smooth(values, radius) {
  return values.map((_, i) => {
    let sum = 0, n = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j++) { sum += values[j]; n++; }
    return sum / n;
  });
}

// loudness: per-second LUFS (sparse array ok). reactions: Map(second -> count). Returns [{ t, score }] by time.
function detectMoments({ loudness = [], reactions = new Map(), max = MAX_MOMENTS, minGap = MIN_GAP, threshold = THRESHOLD } = {}) {
  let length = loudness.length;
  for (const s of reactions.keys()) length = Math.max(length, s + 1);
  if (!length) return [];
  const floor = Math.min(-70, ...loudness.filter(Number.isFinite));
  const loud = Array.from({ length }, (_, i) => (Number.isFinite(loudness[i]) ? loudness[i] : floor));
  const loudZ = zScores(smooth(loud, 1));
  const loudActive = loudness.some(Number.isFinite) && loudZ.some(v => Math.abs(v) > 1e-6);
  const counts = Array.from({ length }, (_, i) => reactions.get(i) || 0);
  const hasReactions = counts.some(Boolean);
  const reactZ = hasReactions ? zScores(smooth(counts, 3)) : counts;
  // Use whichever signals are really present: both when audio has variation, otherwise one alone.
  const score = loud.map((_, i) => (loudActive && hasReactions ? 0.6 * loudZ[i] + 0.4 * reactZ[i] : loudActive ? loudZ[i] : reactZ[i]));
  const peaks = score.map((value, t) => ({ t, score: value })).filter(p => p.score >= threshold).sort((a, b) => b.score - a.score || a.t - b.t);
  const chosen = [];
  for (const peak of peaks) {
    if (chosen.length >= max) break;
    if (chosen.some(c => Math.abs(c.t - peak.t) < minGap)) continue; // nearby peaks are one moment
    chosen.push({ t: peak.t, score: Math.round(peak.score * 100) / 100 });
  }
  return chosen.sort((a, b) => a.t - b.t);
}

function videoEncoder(encoders) {
  if (!encoders || encoders.h264Software) return { args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26'], pix: 'yuv420p' };
  if (encoders.h264) return { args: ['-c:v', encoders.h264, '-b:v', '3M'], pix: 'nv12' };
  return null;
}

function cutClip(ffmpeg, input, t, out, { hls = false, encoder, maxEnd = Infinity } = {}) {
  const start = Math.max(0, t - CLIP_BEFORE);
  const endCap = Math.max(start + 1, Math.min(t + CLIP_AFTER, Number.isFinite(maxEnd) ? maxEnd : t + CLIP_AFTER));
  return ffmpegRun(ffmpeg, ['-loglevel', 'error', '-ss', String(start), '-i', input, '-t', String(endCap - start),
    '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-dn', '-vf', `scale=-2:'trunc(min(720,ih)/2)*2',format=${encoder.pix}`, ...encoder.args,
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart', '-y', out], { hls, timeoutMs: 180000 });
}

class Highlights {
  constructor({ ffmpeg, room, captioner, source, dir, encoders = () => null, analyze, cut } = {}) {
    this.ffmpeg = ffmpeg || null;
    this.room = room;
    this.captioner = captioner || null;
    this.source = source || (movie => (movie?.kind === 'file' && movie.file ? { input: movie.file, hls: false } : null));
    this.dir = dir;
    this.encoders = encoders;
    this.analyze = analyze || ((input, start, end, opts) => loudnessSeries(this.ffmpeg, input, start, end, opts));
    this.cut = cut || ((input, t, out, opts) => cutClip(this.ffmpeg, input, t, out, opts));
    this.reactions = new Map(); // movie id -> Map(second -> count)
    this.watched = new Map();   // movie id -> furthest position seen
    this.result = null;         // { movieId, clips, files }
    this.busy = false;
    if (room) this.observe(room);
  }

  // Read-only tap on what the room already broadcasts (chat, reactions, playback state).
  observe(room) {
    if (room.__highlightsTap) return;
    const original = room.broadcast, tap = msg => this.record(msg);
    room.__highlightsTap = true;
    room.broadcast = function (msg, except) {
      try { tap(msg); } catch { /* observing must never affect the room */ }
      return original.call(this, msg, except);
    };
  }

  record(msg) {
    if (!msg) return;
    if (msg.type === 'state' && msg.state?.movieId) {
      this.watched.set(msg.state.movieId, Math.max(this.watched.get(msg.state.movieId) || 0, Number(msg.state.position) || 0));
      return;
    }
    const item = msg.type === 'chat' ? msg.message : msg.type === 'react' ? msg : null;
    if (!item || item.system || !item.movieId || !Number.isFinite(item.position)) return;
    if (!this.reactions.has(item.movieId)) {
      this.reactions.set(item.movieId, new Map());
      if (this.reactions.size > 5) this.reactions.delete(this.reactions.keys().next().value);
    }
    const counts = this.reactions.get(item.movieId), second = Math.floor(item.position);
    counts.set(second, (counts.get(second) || 0) + 1);
    this.watched.set(item.movieId, Math.max(this.watched.get(item.movieId) || 0, item.position));
  }

  reply(msg) { this.room.broadcast({ type: 'highlights', ...msg }); }

  sync(client) { if (this.result && this.room.movie?.id === this.result.movieId) this.room.send(client.ws, { type: 'highlights', movieId: this.result.movieId, clips: this.result.clips }); }

  async generate(client) {
    if (!this.ffmpeg || !this.dir) return this.reply({ clips: [], reason: 'unavailable' });
    const movie = this.room.movie;
    if (this.busy) return this.room.send(client?.ws, { type: 'highlights', status: 'working', movieId: this.busyFor });
    const src = movie && SUPPORTED.has(movie.kind) ? this.source(movie) : null;
    if (!src) return this.reply({ clips: [], reason: 'unsupported', movieId: movie?.id || null });
    const encoder = videoEncoder(this.encoders());
    if (!encoder) return this.reply({ clips: [], reason: 'unavailable', movieId: movie.id });
    this.busy = true; this.busyFor = movie.id;
    const runId = (this.runId || 0) + 1; this.runId = runId;
    const alive = () => runId === this.runId && this.room.movie?.id === movie.id;
    this.reply({ status: 'working', movieId: movie.id });
    try {
      const watched = Math.max(this.watched.get(movie.id) || 0, this.captioner?.movieId === movie.id ? this.captioner.maxPosition : 0, this.room.currentPosition());
      // Never scan or clip past what the room has actually watched, so highlights can't spoil the next scene.
      const end = Math.min(MAX_ANALYSIS, Math.max(0, Math.floor(watched)));
      if (end < 20) return this.reply({ clips: [], reason: 'too-short', movieId: movie.id });
      let loudness = [];
      try { loudness = await this.analyze(src.input, 0, end, { hls: !!src.hls }); }
      catch (error) { console.warn('  ! Highlights: loudness scan failed:', error.message); }
      if (!loudness.some(Number.isFinite) && this.captioner?.movieId === movie.id) {
        for (const [s, rms] of this.captioner.energy) loudness[s] = 20 * Math.log10(Math.max(rms, 1e-4)); // decoded caption windows
      }
      if (!alive()) return;
      const moments = detectMoments({ loudness, reactions: this.reactions.get(movie.id) || new Map() }).filter(m => m.t < end);
      if (!alive()) return;
      const dir = path.join(this.dir, movie.id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64));
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
      await fs.promises.mkdir(dir, { recursive: true });
      const clips = [], files = new Map();
      for (const [n, moment] of moments.entries()) {
        if (!alive()) return; // stop() was called, or the movie changed: do not start another cut
        const file = path.join(dir, `${n}.mp4`);
        try { await this.cut(src.input, moment.t, file, { hls: !!src.hls, encoder, maxEnd: end }); }
        catch (error) { console.warn('  ! Highlights: clip failed:', error.message); continue; }
        if (!alive()) return;
        files.set(n, file);
        clips.push({ t: moment.t, score: moment.score, url: `/highlights/${path.basename(dir)}/${n}.mp4` });
      }
      if (!alive()) return;
      this.result = { movieId: movie.id, clips, files };
      this.reply({ movieId: movie.id, clips, reason: clips.length ? '' : 'none-found' });
    } catch (error) {
      console.warn('  ! Highlights:', redact(error.message));
      this.reply({ clips: [], reason: 'failed', movieId: movie.id });
    } finally {
      // An older cancelled run must not clear a newer run's busy slot.
      if (runId === this.runId) { this.busy = false; this.busyFor = null; }
    }
  }

  // Same admission rules as saved captions: a room key, and guests only for what is showing now.
  serve(req, res, pathname, key, { local = false, missing } = {}) {
    const deny = missing || (() => { res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end('Not found'); });
    const role = this.room.roleForKey(key, local);
    if (!['GET', 'HEAD'].includes(req.method) || !role) return deny();
    const m = /^\/highlights\/([A-Za-z0-9_-]{1,64})\/(\d{1,2})\.mp4$/.exec(pathname);
    if (!m || !this.result || this.result.movieId !== m[1] || (role !== 'host' && this.room.movie?.id !== m[1])) return deny();
    const file = this.result.files.get(Number(m[2]));
    return file ? serveFile(req, res, file, { type: 'video/mp4' }) : deny();
  }

  stop() {
    this.runId = (this.runId || 0) + 1;         // in-flight generate() loop exits on its next cancellation check
    for (const proc of ffmpegRun.running) { try { proc.kill(); } catch {} }
    this.busy = false; this.busyFor = null;
  }
}

module.exports = { Highlights, detectMoments, parseEbur128Line, loudnessSeries, cutClip, videoEncoder };
