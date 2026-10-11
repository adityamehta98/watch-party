'use strict';
// Locates ffmpeg / ffprobe / cloudflared and detects which video encoders work on this PC.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let IS_SEA = false;
try { IS_SEA = require('node:sea').isSea(); } catch { IS_SEA = false; }
// When packaged as WatchParty.exe, everything (config, cache, bin\ffmpeg.exe) lives next to the exe.
const ROOT = IS_SEA ? path.dirname(process.execPath) : path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';

function exists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// winget installs Gyan.FFmpeg under %LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_*\ffmpeg-*\bin
function wingetPackageBins(exe) {
  const base = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
  const out = [];
  if (!base) return out;
  try {
    for (const pkg of fs.readdirSync(base)) {
      const pkgDir = path.join(base, pkg);
      out.push(path.join(pkgDir, exe));
      try {
        for (const sub of fs.readdirSync(pkgDir)) {
          out.push(path.join(pkgDir, sub, 'bin', exe));
          out.push(path.join(pkgDir, sub, exe));
        }
      } catch { /* not a dir */ }
    }
  } catch { /* no winget packages */ }
  return out;
}

function findBin(name) {
  const exe = IS_WIN ? `${name}.exe` : name;
  const candidates = [path.join(ROOT, 'bin', exe)];
  if (IS_WIN) {
    const la = process.env.LOCALAPPDATA || '';
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    candidates.push(
      path.join(la, 'Microsoft', 'WinGet', 'Links', exe),
      path.join(pf, 'cloudflared', exe),
      path.join(pf86, 'cloudflared', exe),
      path.join(pf, 'ffmpeg', 'bin', exe),
      path.join('C:\\ffmpeg', 'bin', exe),
    );
  }
  for (const c of candidates) if (exists(c)) return c;
  const r = spawnSync(IS_WIN ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true });
  if (r.status === 0 && r.stdout) {
    const first = r.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
    if (first && exists(first)) return first;
  }
  if (IS_WIN) for (const c of wingetPackageBins(exe)) if (exists(c)) return c;
  return null;
}

function run(bin, args, timeoutMs = 20000) {
  return new Promise(resolve => {
    let out = '', err = '';
    let done = false;
    const p = spawn(bin, args, { windowsHide: true });
    const t = setTimeout(() => { if (!done) { try { p.kill(); } catch {} } }, timeoutMs);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => { done = true; clearTimeout(t); resolve({ code: -1, out, err: String(e) }); });
    p.on('close', code => { done = true; clearTimeout(t); resolve({ code, out, err }); });
  });
}

// Hardware encoders are tried first; a test encode confirms the GPU/driver really supports them.
const HEVC_CANDIDATES = ['hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'hevc_videotoolbox'];
const H264_CANDIDATES = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox'];

async function detectEncoders(ffmpeg) {
  const result = { hevc: null, h264: null, aac: null, hevcSoftware: false, h264Software: false, list: [] };
  if (!ffmpeg) return result;
  const r = await run(ffmpeg, ['-hide_banner', '-encoders']);
  const names = new Set();
  for (const line of r.out.split(/\r?\n/)) {
    const m = line.match(/^\s*[AVS][\w.]{5}\s+(\S+)/);
    if (m) names.add(m[1]);
  }
  result.hevcSoftware = names.has('libx265');
  result.h264Software = names.has('libx264');
  const test = async (enc, tenBit) => {
    const pix = tenBit ? 'p010le' : 'nv12';
    const t = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=24',
      '-frames:v', '6', '-pix_fmt', pix, '-c:v', enc, '-f', 'null', '-'], 30000);
    return t.code === 0;
  };
  for (const enc of HEVC_CANDIDATES) {
    if (names.has(enc) && await test(enc, false)) {
      result.hevc = enc;
      result.hevc10 = await test(enc, true);
      break;
    }
  }
  for (const enc of H264_CANDIDATES) {
    if (names.has(enc) && await test(enc, false)) { result.h264 = enc; break; }
  }
  if (!result.hevc && result.hevcSoftware) { result.hevc = 'libx265'; result.hevc10 = true; }
  if (!result.h264 && result.h264Software) result.h264 = 'libx264';
  if (names.has('aac_mf')) {
    const audio = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=5.1',
      '-t', '0.2', '-c:a', 'aac_mf', '-b:a', '640k', '-f', 'null', '-'], 10000);
    if (audio.code === 0) result.aac = 'aac_mf';
  }
  if (!result.aac && names.has('aac')) result.aac = 'aac';
  result.list = [result.hevc, result.h264].filter(Boolean);
  return result;
}

// Does this ffmpeg have the filter that removes Dolby Vision (needed for browser playback)?
async function hasDoviStrip(ffmpeg) {
  if (!ffmpeg) return false;
  const r = await run(ffmpeg, ['-hide_banner', '-bsfs']);
  return /\bdovi_rpu\b/.test(r.out);
}

function encoderLabel(enc) {
  if (!enc) return 'none';
  if (enc.includes('nvenc')) return 'NVIDIA GPU';
  if (enc.includes('qsv')) return 'Intel Quick Sync';
  if (enc.includes('amf')) return 'AMD GPU';
  if (enc.includes('videotoolbox')) return 'Apple VideoToolbox';
  return 'CPU (slow)';
}

module.exports = { findBin, run, detectEncoders, hasDoviStrip, encoderLabel, ROOT, IS_WIN, IS_SEA };
