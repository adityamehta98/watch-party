'use strict';
// Movie library: scans folders, reads codec info with ffprobe, decides whether a browser can
// play a file as-is, and runs ffmpeg "prepare" jobs (repackage / fix audio / compress / subtitles).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { run } = require('./tools');

const VIDEO_EXT = new Set(['.mkv', '.mp4', '.m4v', '.mov', '.webm', '.avi', '.m2ts', '.mts', '.ts', '.wmv']);
const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);
const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', 'node_modules', 'backup', 'certificate', 'clipinf', 'playlist', 'meta', 'auxdata', 'jar', 'bdjo']);
const BROWSER_AUDIO_DIRECT = new Set(['aac', 'mp3', 'opus', 'flac']);
const MP4_AUDIO_COPY = new Set(['aac', 'mp3']);

const LANG_NAMES = {
  eng: 'English', spa: 'Spanish', fre: 'French', fra: 'French', ger: 'German', deu: 'German', ita: 'Italian',
  jpn: 'Japanese', kor: 'Korean', chi: 'Chinese', zho: 'Chinese', hin: 'Hindi', por: 'Portuguese', rus: 'Russian',
  ara: 'Arabic', tam: 'Tamil', tel: 'Telugu', dut: 'Dutch', nld: 'Dutch', swe: 'Swedish', nor: 'Norwegian',
  dan: 'Danish', fin: 'Finnish', pol: 'Polish', tur: 'Turkish', tha: 'Thai', vie: 'Vietnamese', heb: 'Hebrew',
  ces: 'Czech', cze: 'Czech', hun: 'Hungarian', gre: 'Greek', ell: 'Greek', und: 'Unknown',
};
const langName = l => (l && (LANG_NAMES[l.toLowerCase()] || l.toUpperCase())) || '';

function idFor(p) { return crypto.createHash('sha1').update(p.toLowerCase()).digest('hex').slice(0, 12); }

function cleanTitle(name) {
  let t = name.replace(/\.[^.]+$/, '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  const y = t.match(/^(.+?)[\s(\[-]+((?:19|20)\d{2})(?:[\s)\]].*)?$/);
  if (y && y[1].trim().length > 1) return `${y[1].trim()} (${y[2]})`;
  const cut = t.search(/\b(2160p|1080p|720p|480p|4k|uhd|blu-?ray|bdrip|remux|x264|x265|h264|h265|hevc|web-?dl|hdr)\b/i);
  if (cut > 1) t = t.slice(0, cut).trim();
  return t || name;
}

function parseRate(r) {
  if (!r || r === '0/0') return 0;
  const [a, b] = String(r).split('/').map(Number);
  return b ? a / b : a;
}

function fmtBytes(n) {
  if (n > 1e9) return (n / 1e9).toFixed(1) + ' GB';
  if (n > 1e6) return (n / 1e6).toFixed(0) + ' MB';
  return Math.round(n / 1e3) + ' KB';
}

function analyze(probe, item) {
  const fmt = probe.format || {};
  const streams = probe.streams || [];
  const vs = streams.find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const duration = parseFloat(fmt.duration) || parseFloat(vs && vs.duration) || 0;
  const size = item.size || parseInt(fmt.size, 10) || 0;
  const bitrate = parseInt(fmt.bit_rate, 10) || (duration ? (size * 8) / duration : 0);

  let video = null;
  if (vs) {
    const pix = vs.pix_fmt || '';
    const bitDepth = /10|12/.test(pix) ? (pix.includes('12') ? 12 : 10) : (parseInt(vs.bits_per_raw_sample, 10) || 8);
    const sd = vs.side_data_list || [];
    const dvRec = sd.find(x => /dovi|dolby vision/i.test(x.side_data_type || ''));
    const dv = dvRec || /dvh|dvhe|dva/i.test(vs.codec_tag_string || '')
      ? { profile: dvRec && dvRec.dv_profile != null ? Number(dvRec.dv_profile) : null, compat: dvRec && dvRec.dv_bl_signal_compatibility_id != null ? Number(dvRec.dv_bl_signal_compatibility_id) : null, el: !!(dvRec && dvRec.el_present_flag) }
      : null;
    let baseHdr = null;
    if (vs.color_transfer === 'smpte2084') baseHdr = 'HDR10';
    if (vs.color_transfer === 'arib-std-b67') baseHdr = 'HLG';
    const hdr = dv ? (baseHdr ? `Dolby Vision + ${baseHdr}` : 'Dolby Vision') : baseHdr;
    video = {
      index: vs.index, codec: vs.codec_name, profile: vs.profile || '', width: vs.width, height: vs.height,
      pixFmt: pix, bitDepth, hdr, baseHdr, dv, tag: vs.codec_tag_string || '',
      fps: Math.round(parseRate(vs.avg_frame_rate || vs.r_frame_rate) * 1000) / 1000,
      colorPrimaries: vs.color_primaries, colorTransfer: vs.color_transfer, colorSpace: vs.color_space,
      interlaced: !!vs.field_order && !['progressive', 'unknown'].includes(vs.field_order),
    };
  }
  const audios = streams.filter(s => s.codec_type === 'audio').map(s => ({
    index: s.index, codec: s.codec_name, profile: s.profile || '', channels: s.channels || 2,
    layout: s.channel_layout || '', lang: (s.tags && s.tags.language) || '', title: (s.tags && s.tags.title) || '',
    isDefault: !!(s.disposition && s.disposition.default),
  }));
  const subs = streams.filter(s => s.codec_type === 'subtitle').map(s => ({
    index: s.index, codec: s.codec_name, lang: (s.tags && s.tags.language) || '', title: (s.tags && s.tags.title) || '',
    text: TEXT_SUBS.has(s.codec_name), forced: !!(s.disposition && s.disposition.forced),
    isDefault: !!(s.disposition && s.disposition.default),
  }));
  let defaultAudio = audios.find(a => a.isDefault) || audios.find(a => a.lang === 'eng') || audios[0] || null;
  const info = {
    duration, size, bitrateMbps: Math.round(bitrate / 1e5) / 10, container: fmt.format_name || '',
    video, audios, subs, defaultAudioIndex: defaultAudio ? defaultAudio.index : null,
  };
  info.plan = computePlan(info, item.ext);
  return info;
}

function audioLabel(a) {
  if (!a) return '';
  const names = { truehd: 'Dolby TrueHD', eac3: 'Dolby Digital+', ac3: 'Dolby Digital', dts: 'DTS', aac: 'AAC', flac: 'FLAC', opus: 'Opus', mp3: 'MP3', pcm_s16le: 'PCM', pcm_s24le: 'PCM', pcm_bluray: 'PCM' };
  let n = names[a.codec] || a.codec.toUpperCase();
  if (a.codec === 'dts' && /MA/i.test(a.profile)) n = 'DTS-HD MA';
  if (a.codec === 'truehd' && /atmos/i.test(a.title)) n = 'TrueHD Atmos';
  const ch = a.channels >= 8 ? '7.1' : a.channels >= 6 ? '5.1' : a.channels === 1 ? 'mono' : 'stereo';
  return `${n} ${ch}`;
}

function videoBrowserOk(v) {
  if (!v) return { ok: false, why: 'no video track' };
  const c = v.codec;
  if (c === 'h264') {
    if (v.bitDepth > 8) return { ok: false, why: '10-bit H.264 isn\'t supported by browsers' };
    if (!/420/.test(v.pixFmt) && v.pixFmt) return { ok: false, why: `H.264 ${v.pixFmt} isn't supported by browsers` };
    return { ok: true };
  }
  if (c === 'hevc') {
    if (v.pixFmt && !/420/.test(v.pixFmt)) return { ok: false, why: `HEVC ${v.pixFmt} isn't supported by browsers` };
    return { ok: true };
  }
  if (c === 'av1' || c === 'vp9') return { ok: true };
  const pretty = { mpeg2video: 'MPEG-2', vc1: 'VC-1', mpeg4: 'MPEG-4 / DivX', wmv3: 'WMV', msmpeg4v3: 'DivX 3' }[c] || c;
  return { ok: false, why: `${pretty} video isn't supported by browsers` };
}

function computePlan(info, ext) {
  const v = info.video;
  const reasons = [];
  if (!v) return { mode: 'unsupported', reasons: ['No video track found'] };
  const vOk = videoBrowserOk(v);
  const a = info.audios.find(x => x.index === info.defaultAudioIndex);
  const isMp4 = ['.mp4', '.m4v', '.mov'].includes(ext) && /mp4|mov/.test(info.container);
  if (!vOk.ok) {
    reasons.push(vOk.why + ', so the video has to be re-encoded (slower, uses your GPU if available).');
    if (a && !MP4_AUDIO_COPY.has(a.codec)) reasons.push(`${audioLabel(a)} audio will be converted to AAC.`);
    return { mode: 'transcode', reasons };
  }
  const audioDirect = !a || BROWSER_AUDIO_DIRECT.has(a.codec);
  if (v.dv) {
    // Browsers play the sound but show a black picture for many Dolby Vision files.
    // Removing the Dolby Vision layer leaves the normal HDR10/SDR picture, copied bit-for-bit.
    if (v.dv.profile === 5) reasons.push('This is Dolby Vision profile 5 (the streaming-service kind). Browsers can\'t show its colors correctly, so the picture may look purple or green even after preparing. A different (HDR10 or SDR) version of this movie will look right.');
    else reasons.push(`Dolby Vision${v.dv.profile ? ` (profile ${v.dv.profile})` : ''} makes browsers show a black screen, so it will be removed. The normal ${v.baseHdr || 'SDR'} picture underneath is copied bit-for-bit.`);
    if (!isMp4) reasons.push(`${ext.slice(1).toUpperCase()} files are repackaged as MP4 for browsers.`);
    if (a && !MP4_AUDIO_COPY.has(a.codec)) reasons.push(`${audioLabel(a)} audio will be converted to high-bitrate AAC.`);
    return { mode: 'remux', reasons, dv: true };
  }
  if (isMp4 && audioDirect) {
    if (v.codec === 'hevc' && v.tag === 'hev1') reasons.push('HEVC tagged "hev1": fine in Chrome/Edge; Safari/iPhone viewers need a prepared copy.');
    return { mode: 'direct', reasons };
  }
  if (ext === '.webm' && ['vp8', 'vp9', 'av1'].includes(v.codec) && (!a || ['opus', 'vorbis'].includes(a.codec))) {
    return { mode: 'direct', reasons };
  }
  if (!isMp4) reasons.push(`${ext.slice(1).toUpperCase()} files can't be streamed to browsers directly, so the app repackages it as MP4. The video is copied bit-for-bit, so quality stays identical.`);
  if (a && !MP4_AUDIO_COPY.has(a.codec)) {
    reasons.push(BROWSER_AUDIO_DIRECT.has(a.codec)
      ? `${audioLabel(a)} audio will be converted to AAC so every browser can play it.`
      : `${audioLabel(a)} audio isn't supported by browsers, so it'll be converted to high-bitrate AAC ${a.channels >= 6 ? '5.1' : 'stereo'}.`);
  }
  return { mode: 'remux', reasons };
}

function srtToVtt(text) {
  return 'WEBVTT\n\n' + text.replace(/\r/g, '').replace(/^﻿/, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
}

class Library extends EventEmitter {
  constructor({ config, tools, save }) {
    super();
    this.config = config;
    this.tools = tools; // { ffmpeg, ffprobe, encoders }
    this.save = save;
    this.items = new Map();
    this.queue = [];
    this.running = null;
    this.probing = 0;
    this.probeWaiting = [];
    this.scanning = false;
    this.cacheDir = path.resolve(require('./tools').ROOT, config.cacheDir || 'cache');
    fs.mkdirSync(this.cacheDir, { recursive: true });
    this.probeCachePath = path.join(this.cacheDir, 'probe-cache.json');
    try { this.probeCache = JSON.parse(fs.readFileSync(this.probeCachePath, 'utf8')); } catch { this.probeCache = {}; }
    if (this.probeCache.__v !== 2) this.probeCache = { __v: 2 }; // older cache lacked Dolby Vision details
    this._saveProbeCache = debounce(() => {
      fs.writeFile(this.probeCachePath, JSON.stringify(this.probeCache), () => {});
    }, 1000);
  }

  get folders() { return this.config.folders || []; }

  async setFolders(folders) {
    const clean = [...new Set(folders.map(f => String(f).trim().replace(/^"|"$/g, '')).filter(Boolean))];
    const bad = [];
    for (const f of clean) {
      try { if (!(await fsp.stat(f)).isDirectory()) bad.push(f); } catch { bad.push(f); }
    }
    this.config.folders = clean;
    this.save();
    await this.scan();
    return { folders: clean, missing: bad };
  }

  async scan() {
    if (this.scanning) return;
    this.scanning = true;
    this.emit('update');
    const found = new Map();
    const walk = async (dir, depth, root) => {
      if (depth > 8) return;
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
          if (path.resolve(full) === this.cacheDir) continue;
          await walk(full, depth + 1, root);
        } else if (e.isFile()) {
          const ext = path.extname(e.name).toLowerCase();
          if (!VIDEO_EXT.has(ext)) continue;
          let st;
          try { st = await fsp.stat(full); } catch { continue; }
          const inBdmv = /[\\/]BDMV[\\/]STREAM[\\/]/i.test(full);
          if (inBdmv && st.size < 1e9) continue; // skip menus/extras in full-disc backups
          if (st.size < 1e6 || (st.size < 300e6 && /(^|[\s._-])(sample|trailer)([\s._-]|$)/i.test(e.name))) continue; // skip samples/trailers
          let title = cleanTitle(e.name);
          if (inBdmv) title = cleanTitle(path.basename(full.split(/[\\/]BDMV[\\/]/i)[0])) + ` (${e.name})`;
          const id = idFor(full);
          const prev = this.items.get(id);
          const item = (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) ? prev : {
            id, path: full, rel: path.relative(root, full), title, ext, size: st.size, mtimeMs: st.mtimeMs,
            info: null, probeError: null, prepared: null, job: null,
          };
          found.set(id, item);
        }
      }
    };
    for (const f of this.folders) await walk(f, 0, f);
    // keep running jobs attached
    this.items = found;
    for (const item of found.values()) {
      if (!item.prepared) item.prepared = this.loadPrepared(item);
      if (!item.info) {
        const key = this.probeKey(item);
        if (this.probeCache[key]) { try { item.info = analyze(this.probeCache[key], item); } catch {} }
      }
    }
    this.scanning = false;
    this.emit('update');
    // background probe
    for (const item of found.values()) if (!item.info && !item.probeError) this.probe(item.id).catch(() => {});
  }

  probeKey(item) { return `${item.path}|${item.size}|${Math.round(item.mtimeMs)}`; }

  async probe(id) {
    const item = this.items.get(id);
    if (!item) throw new Error('Unknown movie');
    if (item.info) return item.info;
    if (!this.tools.ffprobe) { item.probeError = 'ffprobe not found'; return null; }
    if (this.probing >= 2) await new Promise(r => this.probeWaiting.push(r));
    this.probing++;
    try {
      const r = await run(this.tools.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-probesize', '50M', '-analyzeduration', '20M', item.path], 60000);
      if (r.code !== 0) throw new Error((r.err || 'ffprobe failed').trim().split('\n').pop());
      const json = JSON.parse(r.out);
      // trim what we store
      const slim = { format: { format_name: json.format.format_name, duration: json.format.duration, bit_rate: json.format.bit_rate, size: json.format.size }, streams: (json.streams || []).map(s => ({
        index: s.index, codec_type: s.codec_type, codec_name: s.codec_name, profile: s.profile, codec_tag_string: s.codec_tag_string,
        width: s.width, height: s.height, pix_fmt: s.pix_fmt, bits_per_raw_sample: s.bits_per_raw_sample, field_order: s.field_order,
        color_primaries: s.color_primaries, color_transfer: s.color_transfer, color_space: s.color_space,
        r_frame_rate: s.r_frame_rate, avg_frame_rate: s.avg_frame_rate, duration: s.duration, channels: s.channels, channel_layout: s.channel_layout,
        side_data_list: (s.side_data_list || []).map(x => ({ side_data_type: x.side_data_type, dv_profile: x.dv_profile, dv_bl_signal_compatibility_id: x.dv_bl_signal_compatibility_id, el_present_flag: x.el_present_flag })), disposition: s.disposition, tags: s.tags,
      })) };
      this.probeCache[this.probeKey(item)] = slim;
      this._saveProbeCache();
      item.info = analyze(slim, item);
      item.probeError = null;
    } catch (e) {
      item.probeError = e.message;
    } finally {
      this.probing--;
      const next = this.probeWaiting.shift();
      if (next) next();
      this.emit('update');
    }
    return item.info;
  }

  preparedMetaPath(id) { return path.join(this.cacheDir, `${id}.json`); }

  // A prepared copy of a Dolby Vision movie made by the first version still contains the Dolby Vision
  // layer (black screen), so it has to be prepared again.
  goodPrepared(item) {
    const p = item.prepared;
    if (!p) return null;
    if (p.file && item.info && item.info.video && item.info.video.dv && !p.dvStripped && p.mode !== 'encode') return null;
    return p;
  }

  loadPrepared(item) {
    try {
      const meta = JSON.parse(fs.readFileSync(this.preparedMetaPath(item.id), 'utf8'));
      if (meta.sourceSize !== item.size) return null;
      if (meta.file && !fs.existsSync(path.join(this.cacheDir, meta.file))) return null;
      return meta;
    } catch { return null; }
  }

  externalSubs(item) {
    const dir = path.dirname(item.path);
    const base = path.basename(item.path, path.extname(item.path)).toLowerCase();
    const out = [];
    try {
      for (const f of fs.readdirSync(dir)) {
        const lower = f.toLowerCase();
        if (!/\.(srt|vtt)$/.test(lower) || !lower.startsWith(base)) continue;
        const mid = lower.slice(base.length).replace(/\.(srt|vtt)$/, '').replace(/^[.\s_-]+/, '');
        out.push({ key: 'x' + idFor(f).slice(0, 6), label: mid ? (langName(mid.split('.')[0]) || mid) + ' (file)' : 'Subtitles (file)', lang: mid.split('.')[0] || '', external: path.join(dir, f) });
      }
    } catch { /* ignore */ }
    return out;
  }

  // What the room should load for this movie, or null if it needs preparing first.
  playable(id) {
    const item = this.items.get(id);
    if (!item || !item.info) return null;
    const info = item.info;
    const subs = [];
    let file = null;
    const prepared = this.goodPrepared(item);
    if (prepared && prepared.file) {
      file = path.join(this.cacheDir, prepared.file);
    } else if (info.plan.mode === 'direct') {
      file = item.path;
    } else {
      return null;
    }
    if (prepared) for (const s of prepared.subs || []) subs.push({ key: s.key, label: String(s.label || '').replace(/^(.+) · \1$/i, '$1'), lang: s.lang, file: path.join(this.cacheDir, s.file) });
    for (const s of this.externalSubs(item)) subs.push({ key: s.key, label: s.label, lang: s.lang, file: s.external });
    const v = (prepared && prepared.video) || info.video;
    return {
      id, title: item.title, file, duration: (prepared && prepared.duration) || info.duration,
      width: v.width, height: v.height, hdr: v.hdr, codec: v.codec,
      mbps: (prepared && prepared.bitrateMbps) || info.bitrateMbps,
      audio: prepared ? prepared.audioLabel : audioLabel(info.audios.find(a => a.index === info.defaultAudioIndex)),
      subs,
    };
  }

  subFile(id, key) {
    const p = this.playable(id);
    const s = p && p.subs.find(x => x.key === key);
    return s ? s.file : null;
  }

  readSub(file) {
    const text = fs.readFileSync(file, 'utf8');
    return file.toLowerCase().endsWith('.srt') ? srtToVtt(text) : text;
  }

  list() {
    return {
      folders: this.folders,
      scanning: this.scanning,
      cacheDir: this.cacheDir,
      encoders: this.tools.encoders,
      items: [...this.items.values()].sort((a, b) => a.title.localeCompare(b.title)).map(it => ({
        id: it.id, title: it.title, rel: it.rel, size: it.size, sizeLabel: fmtBytes(it.size), ext: it.ext,
        info: it.info && {
          duration: it.info.duration, bitrateMbps: it.info.bitrateMbps, video: it.info.video, plan: it.info.plan,
          audios: it.info.audios.map(a => ({ index: a.index, label: audioLabel(a), lang: langName(a.lang), title: a.title, channels: a.channels, codec: a.codec })),
          subs: it.info.subs.map(s => ({ index: s.index, label: s.title || langName(s.lang) || `Track ${s.index}`, lang: langName(s.lang), text: s.text, forced: s.forced, codec: s.codec })),
          defaultAudioIndex: it.info.defaultAudioIndex,
        },
        probeError: it.probeError,
        stalePrepared: !!(it.prepared && !this.goodPrepared(it)),
        prepared: this.goodPrepared(it) && { mode: it.prepared.mode, sizeLabel: fmtBytes(it.prepared.outSize || 0), bitrateMbps: it.prepared.bitrateMbps, audioLabel: it.prepared.audioLabel, compressed: it.prepared.compressed, subs: (it.prepared.subs || []).length, createdAt: it.prepared.createdAt },
        playable: !!(it.info && (this.goodPrepared(it) || it.info.plan.mode === 'direct')),
        externalSubs: this.externalSubs(it).length,
        job: it.job && { state: it.job.state, percent: it.job.percent, speed: it.job.speed, eta: it.job.eta, error: it.job.error, label: it.job.label },
      })),
    };
  }

  // ---------- prepare jobs ----------
  prepare(id, opts = {}) {
    const item = this.items.get(id);
    if (!item) throw new Error('Unknown movie');
    if (!item.info) throw new Error('Movie info not loaded yet');
    if (!this.tools.ffmpeg) throw new Error('ffmpeg was not found. Run "Start Watch Party.bat" again to install it.');
    if (item.job && ['queued', 'running'].includes(item.job.state)) return item.job;
    const info = item.info;
    const compress = !!opts.compress;
    const mustEncode = info.plan.mode === 'transcode';
    const audio = info.audios.find(a => a.index === Number(opts.audioIndex)) || info.audios.find(a => a.index === info.defaultAudioIndex) || null;
    const audioMode = opts.audioMode === 'stereo' ? 'stereo' : 'surround';
    const textSubs = info.subs.filter(s => s.text);
    const subsOnly = info.plan.mode === 'direct' && !compress && (!audio || audio.index === info.defaultAudioIndex) && audioMode === 'surround';
    if (subsOnly && !textSubs.length) throw new Error('This movie already plays directly and has no text subtitles to extract.');
    const job = {
      id, state: 'queued', percent: 0, speed: null, eta: null, error: null, proc: null,
      opts: { compress, mustEncode, targetMbps: Math.max(4, Math.min(80, Number(opts.targetMbps) || 25)), audio, audioMode, textSubs, subsOnly },
      label: subsOnly ? 'Extracting subtitles' : (compress || mustEncode) ? `Re-encoding video (${require('./tools').encoderLabel(this.pickEncoder(info, compress).enc)})` : 'Repackaging (video copied as-is)',
    };
    item.job = job;
    this.queue.push(item);
    this.emit('update');
    this.pump();
    return job;
  }

  pickEncoder(info, compress, software = false) {
    const all = this.tools.encoders || {};
    const enc = software ? { hevc: all.hevcSoftware ? 'libx265' : null, h264: all.h264Software ? 'libx264' : null, hevc10: true } : all;
    const v = info.video;
    const wantHevc = compress ? (v.bitDepth > 8 || !!v.hdr || v.width > 1920 || v.codec === 'hevc') : false;
    if (wantHevc && enc.hevc) return { enc: enc.hevc, hevc: true, tenBit: v.bitDepth > 8 && (enc.hevc10 !== false) };
    if (enc.h264) return { enc: enc.h264, hevc: false, tenBit: false };
    if (enc.hevc) return { enc: enc.hevc, hevc: true, tenBit: false };
    return { enc: 'libx264', hevc: false, tenBit: false };
  }

  videoEncodeArgs(info, compress, targetMbps, software = false) {
    const { enc, hevc, tenBit } = this.pickEncoder(info, compress, software);
    const v = info.video;
    const T = targetMbps;
    const br = compress ? ['-b:v', `${T}M`, '-maxrate', `${Math.round(T * 1.6)}M`, '-bufsize', `${T * 2}M`] : null;
    const a = [];
    if (v.interlaced) a.push('-vf', 'bwdif=mode=send_frame:deint=interlaced');
    const hw = !enc.startsWith('lib');
    if (enc.includes('nvenc')) {
      a.push('-c:v', enc, '-preset', 'p5', '-tune', 'hq', '-spatial-aq', '1');
      a.push(...(br ? ['-rc', 'vbr', ...br] : ['-rc', 'vbr', '-cq', '19', '-b:v', '0', '-maxrate', '60M', '-bufsize', '120M']));
    } else if (enc.includes('qsv')) {
      a.push('-c:v', enc, '-preset', 'slow');
      a.push(...(br || ['-global_quality', '20']));
    } else if (enc.includes('amf')) {
      a.push('-c:v', enc, '-quality', 'quality');
      a.push(...(br ? ['-rc', 'vbr_peak', ...br.slice(0, 4)] : ['-rc', 'cqp', '-qp_i', '18', '-qp_p', '20']));
    } else if (enc.includes('videotoolbox')) {
      a.push('-c:v', enc, ...(br || ['-q:v', '65']));
    } else if (enc === 'libx265') {
      a.push('-c:v', 'libx265', '-preset', 'fast', ...(br || ['-crf', '18']), '-x265-params', 'log-level=error');
    } else {
      a.push('-c:v', 'libx264', '-preset', 'veryfast', ...(br || ['-crf', '18']));
    }
    if (tenBit) a.push('-pix_fmt', hw ? 'p010le' : 'yuv420p10le', '-profile:v', 'main10');
    else a.push('-pix_fmt', hw ? 'nv12' : 'yuv420p');
    if (hevc) a.push('-tag:v', 'hvc1');
    if (tenBit && v.hdr && v.colorTransfer) {
      a.push('-color_primaries', v.colorPrimaries || 'bt2020', '-color_trc', v.colorTransfer, '-colorspace', v.colorSpace || 'bt2020nc');
    }
    return { args: a, hevc, enc };
  }

  async pump() {
    if (this.running || !this.queue.length) return;
    const item = this.queue.shift();
    if (!item.job || item.job.state !== 'queued') return this.pump();
    this.running = item;
    try { await this.runJob(item); } catch (e) {
      if (item.job && item.job.state !== 'cancelled') { item.job.state = 'error'; item.job.error = e.message; }
    }
    this.running = null;
    this.emit('update');
    this.pump();
  }

  async runJob(item) {
    const job = item.job;
    const info = item.info;
    const o = job.opts;
    const encodeVideo = o.compress || o.mustEncode;
    job.state = 'running';
    this.emit('update');

    // disk space check
    const estimate = o.subsOnly ? 50e6 : encodeVideo ? (o.targetMbps * 1e6 / 8) * info.duration * 1.2 : item.size * 1.05;
    if (fsp.statfs) {
      try {
        const s = await fsp.statfs(this.cacheDir);
        const free = s.bavail * s.bsize;
        if (free < estimate) throw new Error(`Not enough disk space in ${this.cacheDir}: need about ${fmtBytes(estimate)}, ${fmtBytes(free)} free. Change "cacheDir" in config.json to a bigger drive.`);
      } catch (e) { if (/disk space/.test(e.message)) throw e; }
    }

    const tmpVideo = path.join(this.cacheDir, `${item.id}.part.mp4`);
    const outVideo = `${item.id}.mp4`;
    let videoCodecOut = info.video.codec;
    let encName = null;
    let subOuts = [];
    const buildArgs = attempt => {
    subOuts = [];
    const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats'];
    if (encodeVideo && attempt.hwaccel) args.push('-hwaccel', 'auto');
    args.push('-fflags', '+genpts', '-i', item.path);
    if (!o.subsOnly) {
      args.push('-map', `0:${info.video.index}`);
      if (o.audio) args.push('-map', `0:${o.audio.index}`);
      args.push('-map_metadata', '-1', '-map_chapters', '-1');
      if (encodeVideo) {
        const ve = this.videoEncodeArgs(info, o.compress, o.targetMbps, attempt.software);
        args.push(...ve.args);
        videoCodecOut = ve.hevc ? 'hevc' : 'h264';
        encName = ve.enc;
      } else {
        args.push('-c:v', 'copy');
        if (info.video.codec === 'hevc') args.push('-tag:v', 'hvc1');
      }
      if (info.video.dv && this.tools.dovi && (!encodeVideo || videoCodecOut === 'hevc')) args.push('-bsf:v', 'dovi_rpu=strip=1');
      if (o.audio) {
        const ch = o.audio.channels || 2;
        const stereo = o.audioMode === 'stereo';
        if (MP4_AUDIO_COPY.has(o.audio.codec) && (!stereo || ch <= 2) && ch <= 6) {
          args.push('-c:a', 'copy');
        } else {
          const outCh = stereo || ch < 6 ? 2 : 6;
          args.push('-c:a', 'aac', '-b:a', outCh > 2 ? '640k' : '256k');
          if (ch !== outCh) args.push('-ac', String(outCh));
        }
      }
      // Browsers seek fine with the index at the end (they use range requests), so skip the slow
      // "faststart" rewrite for bit-for-bit copies of huge files; keep it for (smaller) re-encodes.
      args.push('-sn', '-dn', '-max_muxing_queue_size', '4096');
      if (encodeVideo) args.push('-movflags', '+faststart');
      args.push('-f', 'mp4', tmpVideo);
    }
    for (const s of o.textSubs) {
      const key = 's' + s.index;
      const file = `${item.id}.${key}.vtt`;
      const tmp = path.join(this.cacheDir, `${item.id}.${key}.part.vtt`);
      args.push('-map', `0:${s.index}`, '-c:s', 'webvtt', '-f', 'webvtt', tmp);
      let label = s.title || langName(s.lang) || `Subtitle ${s.index}`;
      if (s.title && s.lang && s.title.toLowerCase() !== langName(s.lang).toLowerCase()) label = `${langName(s.lang)} · ${s.title}`;
      if (s.forced && !/forced/i.test(label)) label += ' (forced)';
      subOuts.push({ key, file, tmp, label, lang: s.lang });
    }
    return args;
    };

    const duration = info.duration || 1;
    const runOnce = args => new Promise((resolve, reject) => {
      const p = spawn(this.tools.ffmpeg, args, { windowsHide: true });
      job.proc = p;
      let errText = '';
      let buf = '';
      const started = Date.now();
      p.stdout.on('data', d => {
        buf += d;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        let changed = false;
        for (const line of lines) {
          const [k, val] = line.split('=');
          if (k === 'out_time_us' || k === 'out_time_ms') {
            const t = parseInt(val, 10) / 1e6;
            if (t > 0) { job.percent = Math.min(99.9, (t / duration) * 100); changed = true; }
          } else if (k === 'speed') {
            const sp = parseFloat(val);
            if (sp > 0) job.speed = sp;
          }
        }
        if (changed) {
          const elapsed = (Date.now() - started) / 1000;
          if (job.percent > 0.5) job.eta = Math.round(elapsed * (100 - job.percent) / job.percent);
          this.emitProgress(item);
        }
      });
      p.stderr.on('data', d => { errText = (errText + d).slice(-4000); });
      p.on('error', reject);
      p.on('close', code => {
        job.proc = null;
        if (job.state === 'cancelled') return reject(new Error('cancelled'));
        if (code !== 0) return reject(new Error(errText.trim().split('\n').slice(-3).join(' ') || `ffmpeg exited with code ${code}`));
        resolve();
      });
    });

    // If the graphics card can't decode or encode this file, fall back step by step to the CPU.
    const hwEncoder = encodeVideo && !this.pickEncoder(info, o.compress).enc.startsWith('lib');
    const attempts = encodeVideo
      ? [{ hwaccel: true, software: false }, { hwaccel: false, software: false }, ...(hwEncoder ? [{ hwaccel: false, software: true }] : [])]
      : [{}];
    for (let i = 0; i < attempts.length; i++) {
      try {
        await runOnce(buildArgs(attempts[i]));
        break;
      } catch (e) {
        for (const f of [tmpVideo, ...subOuts.map(x => x.tmp)]) fs.rmSync(f, { force: true });
        if (job.state === 'cancelled' || i === attempts.length - 1) throw e;
        job.percent = 0; job.eta = null;
        if (attempts[i + 1].software) job.label = 'Re-encoding video (CPU, slower: the graphics card could not handle this file)';
        this.emit('update');
      }
    }

    // finalize
    const subs = [];
    for (const s of subOuts) {
      try {
        const st = fs.statSync(s.tmp);
        if (st.size > 20) { fs.renameSync(s.tmp, path.join(this.cacheDir, s.file)); subs.push({ key: s.key, file: s.file, label: s.label, lang: s.lang }); }
        else fs.rmSync(s.tmp, { force: true });
      } catch { /* skip */ }
    }
    const meta = {
      id: item.id, sourcePath: item.path, sourceSize: item.size, createdAt: Date.now(),
      mode: o.subsOnly ? 'subs' : encodeVideo ? 'encode' : 'remux', compressed: !!o.compress, subs,
      duration: info.duration,
    };
    if (!o.subsOnly) {
      fs.rmSync(path.join(this.cacheDir, outVideo), { force: true });
      fs.renameSync(tmpVideo, path.join(this.cacheDir, outVideo));
      const outSize = fs.statSync(path.join(this.cacheDir, outVideo)).size;
      meta.file = outVideo;
      meta.outSize = outSize;
      meta.bitrateMbps = Math.round((outSize * 8 / Math.max(1, info.duration)) / 1e5) / 10;
      const stripped = !!(info.video.dv && this.tools.dovi);
      meta.dvStripped = stripped;
      meta.video = { ...info.video, dv: stripped ? null : info.video.dv, codec: videoCodecOut, bitDepth: encodeVideo && videoCodecOut === 'h264' ? 8 : info.video.bitDepth, hdr: (encodeVideo && videoCodecOut === 'h264') ? null : (stripped ? info.video.baseHdr : info.video.hdr) };
      meta.encoder = encName;
      const ch = o.audio ? ((o.audioMode === 'stereo' || (o.audio.channels || 2) < 6) ? 2 : 6) : 0;
      meta.audioLabel = o.audio ? (MP4_AUDIO_COPY.has(o.audio.codec) && (o.audio.channels <= 2 || (o.audioMode !== 'stereo' && o.audio.channels <= 6)) ? audioLabel(o.audio) : `AAC ${ch >= 6 ? '5.1' : 'stereo'} (from ${audioLabel(o.audio)})`) : 'no audio';
    } else {
      meta.file = null;
    }
    // remove old prepared video if this run was subtitle-only and replaced nothing
    fs.writeFileSync(this.preparedMetaPath(item.id), JSON.stringify(meta, null, 2));
    item.prepared = meta;
    job.state = 'done';
    job.percent = 100;
    job.eta = 0;
    setTimeout(() => { if (item.job === job) { item.job = null; this.emit('update'); } }, 8000);
  }

  emitProgress(item) {
    const now = Date.now();
    if (item._lastEmit && now - item._lastEmit < 700) return;
    item._lastEmit = now;
    this.emit('progress', { id: item.id, job: { state: item.job.state, percent: item.job.percent, speed: item.job.speed, eta: item.job.eta, label: item.job.label } });
  }

  cancel(id) {
    const item = this.items.get(id);
    if (!item || !item.job) return;
    const job = item.job;
    job.state = 'cancelled';
    this.queue = this.queue.filter(x => x !== item);
    if (job.proc) { try { job.proc.kill('SIGKILL'); } catch {} }
    item.job = null;
    this.emit('update');
  }

  removePrepared(id) {
    const item = this.items.get(id);
    if (!item) return;
    const meta = item.prepared;
    if (meta) {
      if (meta.file) fs.rmSync(path.join(this.cacheDir, meta.file), { force: true });
      for (const s of meta.subs || []) fs.rmSync(path.join(this.cacheDir, s.file), { force: true });
    }
    fs.rmSync(this.preparedMetaPath(id), { force: true });
    item.prepared = null;
    this.emit('update');
  }

  shutdown() {
    for (const it of this.items.values()) if (it.job && it.job.proc) { try { it.job.proc.kill('SIGKILL'); } catch {} }
  }

  // Delete every prepared copy (converted movies, subtitles, half-finished ones) so they don't pile up
  // on the disk. Keeps only the small things: settings, certificates, the scan list and the log.
  clearPrepared() {
    let freed = 0, n = 0;
    const isPrepared = f => /^[0-9a-f]{12}(\.json|\.mp4|\.part\.mp4|\.[^.]+\.vtt|\.[^.]+\.part\.vtt)$/i.test(f);
    let names = [];
    try { names = fs.readdirSync(this.cacheDir); } catch { return { freed, n }; }
    for (const f of names) {
      if (!isPrepared(f)) continue;
      const full = path.join(this.cacheDir, f);
      try { const st = fs.statSync(full); fs.rmSync(full, { force: true }); freed += st.size; n++; } catch { /* still open: next time */ }
    }
    for (const it of this.items.values()) it.prepared = null;
    return { freed, n };
  }
}

function debounce(fn, ms) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

module.exports = { Library, analyze, computePlan, cleanTitle, audioLabel };
