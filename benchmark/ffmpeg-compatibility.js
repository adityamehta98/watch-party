'use strict';
// Local-only compatibility checks. Original movies are read, never modified.
// Reports include private paths and belong in the ignored cache directory.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Library, analyze } = require('../server/library');
const { detectEncoders, hasDoviStrip, ROOT } = require('../server/tools');
const value = flag => process.argv[process.argv.indexOf(flag) + 1];
const bin = path.resolve(process.argv.includes('--bin') ? value('--bin') : path.join(ROOT, 'bin'));
const reportFile = path.resolve(process.argv.includes('--report') ? value('--report') : path.join(ROOT, 'cache', 'ffmpeg-compatibility.json'));
const work = path.join(ROOT, 'cache', 'ffmpeg-validation');
const report = { generatedAt: new Date().toISOString(), binaries: {}, capabilities: {}, content: [], fixtures: [], checks: [] };
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(path.dirname(reportFile), { recursive: true });
const save = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
if (process.argv.includes('--reuse-content')) report.content = JSON.parse(fs.readFileSync(path.resolve(value('--reuse-content')), 'utf8')).content;
const ffmpeg = path.join(bin, 'ffmpeg.exe'), ffprobe = path.join(bin, 'ffprobe.exe');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function run(tool, args, timeout = 120000) {
  return new Promise(resolve => {
    let stdout = '', stderr = '', timedOut = false;
    const child = spawn(tool, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.stdout.on('data', b => { if (stdout.length < 16 * 1024 * 1024) stdout += b; });
    child.stderr.on('data', b => { stderr = (stderr + b).slice(-32000); });
    child.on('error', error => { clearTimeout(timer); resolve({ ok: false, error: error.message }); });
    child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0 && !timedOut, code, timedOut, stdout, error: stderr.trim() }); });
  });
}
const ff = args => run(ffmpeg, ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', ...args]);
async function probe(file) {
  const result = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-probesize', '50M', '-analyzeduration', '20M', file], 60000);
  if (!result.ok) throw Error(result.error || 'Probe failed');
  return JSON.parse(result.stdout);
}
async function check(name, task) {
  try { const details = await task(); report.checks.push({ name, ok: true, ...details }); }
  catch (error) { report.checks.push({ name, ok: false, error: error.message }); }
  save(); console.log(`${report.checks.at(-1).ok ? 'PASS' : 'FAIL'} ${name}`);
}
async function decode(file, at, allStreams = true) {
  const result = await ff(['-ss', String(at), '-threads', '2', '-i', file,
    '-map', allStreams ? '0:V?' : '0:v:0', '-map', '0:a?', '-sn', '-dn', '-t', '0.25', '-frames:v', '3', '-threads', '2', '-f', 'null', '-']);
  return { at, ok: result.ok, error: result.ok ? undefined : result.error };
}
function filesIn(folders) {
  const extensions = new Set(['.mkv', '.mp4', '.m4v', '.mov', '.webm', '.avi', '.m2ts', '.mts', '.ts', '.wmv']);
  const files = new Set();
  const walk = (dir, depth = 0) => {
    if (depth > 8) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file, depth + 1);
      else if (entry.isFile() && extensions.has(path.extname(file).toLowerCase())) files.add(file);
    }
  };
  for (const folder of folders) walk(folder);
  return [...files].sort();
}
async function content() {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const files = filesIn(config.folders || []);
  console.log(`Testing ${files.length} local files; three short decode windows per file.`);
  let index = 0, completed = 0;
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (index < files.length) {
      const file = files[index++], item = { id: crypto.createHash('sha256').update(file).digest('hex').slice(0, 12), path: file, ext: path.extname(file).toLowerCase(), size: fs.statSync(file).size };
      try {
        const metadata = await probe(file), info = analyze(metadata, item);
        const duration = info.duration;
        const windows = [];
        for (const at of [...new Set([0, Math.max(0, duration / 2), Math.max(0, duration - 10)])]) windows.push(await decode(file, at));
        report.content.push({ ...item, info, windows, ok: windows.every(window => window.ok) });
      } catch (error) { report.content.push({ ...item, ok: false, error: error.message }); }
      completed++; save();
      if (completed % 10 === 0 || completed === files.length) console.log(`Local files checked: ${completed}/${files.length}; failures: ${report.content.filter(item => !item.ok).length}`);
    }
  }));
}
async function prepared(library, source, label, opts = {}) {
  const id = crypto.createHash('sha256').update(label).digest('hex').slice(0, 12);
  const item = { id, path: source, ext: path.extname(source), size: fs.statSync(source).size, mtimeMs: fs.statSync(source).mtimeMs, prepared: null, job: null };
  item.info = analyze(await probe(source), item); library.items.set(id, item);
  const job = library.prepare(id, { hls: true, ...opts });
  const deadline = Date.now() + 180000;
  while (['queued', 'running'].includes(job.state)) {
    if (Date.now() > deadline) { job.proc?.kill(); throw Error('Preparation timed out'); }
    await sleep(100);
  }
  if (job.state !== 'done') throw Error(job.error || job.state);
  const outputs = [];
  if (item.prepared.file) outputs.push(path.join(library.cacheDir, item.prepared.file));
  if (item.prepared.hls) outputs.push(path.join(library.cacheDir, item.prepared.hls.dir, 'index.m3u8'));
  if (!outputs.length) throw Error('Preparation produced no playable output');
  for (const file of outputs) {
    const result = await decode(file, 0);
    if (!result.ok) throw Error('Prepared output did not decode: ' + result.error);
    const outputInfo = await probe(file);
    if (!outputInfo.streams.some(stream => stream.codec_type === 'video')) throw Error('Output has no video');
    if (item.info.video.dv && library.tools.dovi && outputInfo.streams.some(stream => stream.side_data_list?.some(side => /dovi|dolby vision/i.test(side.side_data_type)))) throw Error('Dolby Vision side data was not stripped');
  }
  for (const sub of item.prepared.subs || []) if (!fs.readFileSync(path.join(library.cacheDir, sub.file), 'utf8').startsWith('WEBVTT')) throw Error('Subtitle extraction failed');
  return { mode: item.prepared.mode, encoder: item.prepared.encoder, subtitles: (item.prepared.subs || []).length, outputs: outputs.length };
}
async function features() {
  const encoders = await detectEncoders(ffmpeg), dovi = await hasDoviStrip(ffmpeg);
  report.capabilities.selectedEncoders = encoders; report.capabilities.doviStrip = dovi;
  const software = { ...encoders, h264: 'libx264', hevc: 'libx265', hevc10: true, aac: 'aac' };
  const library = new Library({ config: { cacheDir: path.join(work, 'prepared') }, tools: { ffmpeg, ffprobe, encoders: software, dovi }, save() {} });
  const specs = [
    ['h264-aac.mp4', 'libx264', 'aac', []], ['h264-opus.mkv', 'libx264', 'libopus', []],
    ['hevc10-eac3.mkv', 'libx265', 'eac3', ['-pix_fmt', 'yuv420p10le', '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc']],
    ['mpeg4-mp3.avi', 'mpeg4', 'libmp3lame', []], ['vp9-opus.webm', 'libvpx-vp9', 'libopus', ['-deadline', 'realtime']],
    ['wmv-wma.wmv', 'wmv2', 'wmav2', ['-ac', '2']], ['h264-pcm.mov', 'libx264', 'pcm_s16le', []],
    ['h264-aac.m4v', 'libx264', 'aac', ['-f', 'mp4']], ['h264-ac3.ts', 'libx264', 'ac3', []],
    ['h264-aac.ts', 'libx264', 'aac', []], ['h264-ac3.mts', 'libx264', 'ac3', ['-f', 'mpegts']], ['h264-ac3.m2ts', 'libx264', 'ac3', ['-f', 'mpegts']],
    ['av1-aac.mp4', 'libaom-av1', 'aac', ['-cpu-used', '8']], ['h264-dts.mkv', 'libx264', 'dca', ['-strict', '-2']],
    ['h264-truehd.mkv', 'libx264', 'truehd', ['-strict', '-2']], ['h264-flac.mkv', 'libx264', 'flac', []],
    ['interlaced.mkv', 'mpeg2video', 'ac3', ['-flags', '+ildct+ilme', '-field_order', 'tt']],
  ];
  for (const [name, video, audio, extra] of specs) await check('fixture: ' + name, async () => {
    const file = path.join(work, name);
    const result = await ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=12', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=5.1',
      '-t', '2', '-c:v', video, '-threads', '2', '-c:a', audio, ...extra, file]);
    if (!result.ok) throw Error(result.error);
    const info = await probe(file); report.fixtures.push({ name, streams: info.streams.map(stream => ({ type: stream.codec_type, codec: stream.codec_name, channels: stream.channels, pixFmt: stream.pix_fmt })) });
    return await prepared(library, file, 'prepare-' + name);
  });
  const baseline = path.join(work, 'h264-aac.mp4');
  for (const [label, source, opts] of [
    ['software H264 compression + stereo + faststart', baseline, { compress: true, targetMbps: 4, audioMode: 'stereo' }],
    ['software HEVC10 HDR compression', path.join(work, 'hevc10-eac3.mkv'), { compress: true, targetMbps: 4 }],
  ]) await check(label, () => prepared(library, source, label, opts));
  const hardware = new Library({ config: { cacheDir: path.join(work, 'hardware-prepared') }, tools: { ffmpeg, ffprobe, encoders, dovi }, save() {} });
  await check('detected hardware H264 compression', () => prepared(hardware, baseline, 'hardware-h264', { compress: true, targetMbps: 4, audioMode: 'stereo' }));
  await check('detected hardware HEVC10 compression', () => prepared(hardware, path.join(work, 'hevc10-eac3.mkv'), 'hardware-hevc', { compress: true, targetMbps: 4 }));
  const fallback = new Library({ config: { cacheDir: path.join(work, 'fallback-prepared') }, tools: { ffmpeg, ffprobe, encoders: { ...software, h264: 'h264_nvenc_unavailable_test' }, dovi }, save() {} });
  await check('failed hardware encoder falls back to software', async () => {
    const details = await prepared(fallback, baseline, 'hardware-fallback', { compress: true, targetMbps: 4 });
    if (details.encoder !== 'libx264') throw Error('Software fallback was not used'); return details;
  });
  await check('direct MP4 preparation without HLS', () => prepared(library, path.join(work, 'h264-opus.mkv'), 'direct-remux', { hls: false }));
  await check('software compression without HLS', () => prepared(library, baseline, 'direct-compress', { hls: false, compress: true, targetMbps: 4 }));
  for (const [extension, codec, text] of [
    ['srt', 'srt', '1\n00:00:00,000 --> 00:00:01,500\nCompatibility check\n'],
    ['ass', 'ass', '[Script Info]\nScriptType: v4.00+\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:00:01.50,Default,,0,0,0,,Compatibility check\n'],
    ['vtt', 'webvtt', 'WEBVTT\n\n00:00.000 --> 00:01.500\nCompatibility check\n'],
  ]) await check('embedded subtitle extraction: ' + codec, async () => {
    const sub = path.join(work, 'captions.' + extension); fs.writeFileSync(sub, text);
    const source = path.join(work, 'sub-' + codec + '.mkv');
    const result = await ff(['-i', baseline, '-i', sub, '-map', '0:v', '-map', '0:a', '-map', '1:0', '-c', 'copy', '-c:s', codec, source]);
    if (!result.ok) throw Error(result.error);
    const details = await prepared(library, source, 'sub-' + codec);
    if (details.subtitles !== 1) throw Error('Embedded subtitle was not extracted'); return details;
  });
  await check('MP4 mov_text subtitle extraction', async () => {
    const source = path.join(work, 'sub-movtext.mp4');
    const result = await ff(['-i', baseline, '-i', path.join(work, 'captions.srt'), '-map', '0:v', '-map', '0:a', '-map', '1:0', '-c', 'copy', '-c:s', 'mov_text', source]);
    if (!result.ok) throw Error(result.error);
    const details = await prepared(library, source, 'sub-movtext');
    if (details.subtitles !== 1) throw Error('mov_text was not extracted'); return details;
  });
  const groups = new Map();
  for (const item of report.content.filter(item => item.ok)) {
    const info = item.info, key = [info.video.codec, info.video.bitDepth, info.video.hdr, info.video.dv?.profile, ...info.audios.map(audio => audio.codec + ':' + audio.channels)].join('|');
    if (!groups.has(key)) groups.set(key, item);
  }
  for (const [group, item] of groups) await check('real content preparation: ' + item.id, async () => {
    const clip = path.join(work, item.id + '.mkv');
    const result = await ff(['-ss', String(Math.max(0, item.info.duration / 2)), '-i', item.path, '-t', '2', '-map', '0:V:0', '-map', '0:a?', '-c', 'copy', '-sn', '-dn', clip]);
    if (!result.ok) throw Error(result.error);
    const details = await prepared(library, clip, item.id);
    const metadata = await probe(clip);
    const alternate = metadata.streams.filter(stream => stream.codec_type === 'audio')[1];
    if (alternate) await prepared(library, clip, item.id + '-alternate', { audioIndex: alternate.index, audioMode: 'stereo' });
    return { group, alternateAudioTested: !!alternate, ...details };
  });
}
(async () => {
  for (const file of [ffmpeg, ffprobe]) report.binaries[path.basename(file)] = { sha256: hash(file), bytes: fs.statSync(file).size };
  for (const kind of ['version', 'decoders', 'encoders', 'demuxers', 'muxers', 'filters', 'bsfs', 'protocols']) {
    const result = await run(ffmpeg, ['-hide_banner', '-' + kind]);
    if (!result.ok) throw Error('Capability inventory failed: ' + kind);
    report.capabilities[kind] = result.stdout + result.error;
  }
  if (!process.argv.includes('--fixtures-only')) await content();
  if (!process.argv.includes('--content-only')) await features();
  save();
  const summary = { files: report.content.length, contentFailures: report.content.filter(item => !item.ok).length, featureChecks: report.checks.length, featureFailures: report.checks.filter(item => !item.ok).length, report: path.relative(ROOT, reportFile) };
  console.log(JSON.stringify(summary));
  if (summary.contentFailures || summary.featureFailures) process.exitCode = 1;
})().catch(error => { report.fatal = error.message; save(); console.error(error.message); process.exitCode = 1; });