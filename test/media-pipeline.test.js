'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const APP_ROOT = require('../server/tools').ROOT;
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('AAC stream copy converts ADTS framing before writing fragmented MP4', () => {
  const { buildHlsArgs } = require('../server/library');
  const info = { video: { index: 0 }, audios: [{ index: 1, codec: 'aac', channels: 2 }] };
  const args = buildHlsArgs({ source: 'movie.ts', info, options: { subsOnly: true, audio: info.audios[0] }, videoCodec: 'h264', stripDv: false, copyAudio: true });
  assert.equal(args[args.indexOf('-c:a') + 1], 'copy');
  assert.equal(args[args.indexOf('-bsf:a') + 1], 'aac_adtstoasc');
});

test('service URLs are canonicalized and custom sites cannot target private networks', () => {
  const { identify } = require('../server/services');
  assert.deepEqual(identify('https://youtu.be/dQw4w9WgXcQ?t=2').videoId, 'dQw4w9WgXcQ');
  assert.equal(identify('https://www.netflix.com/watch/123?trackId=7').url, 'https://www.netflix.com/watch/123');
  assert.equal(identify('https://amazon.com/', {}), null);
  assert.equal(identify('https://example.com/watch?ep=3#x', { custom: true }).url, 'https://example.com/watch?ep=3');
  for (const u of ['http://localhost/x', 'http://127.0.0.1/x', 'http://2130706433/x', 'http://192.168.1.2/x', 'http://[::1]/x', 'https://user:pass@example.com/x']) {
    assert.equal(identify(u, { custom: true }), null, u);
  }
});

test('front-door guard normalizes addresses, limits connections, and blocks repeated guesses', () => {
  const { Guard, norm, isLoopback, isLan } = require('../server/guard');
  assert.equal(norm('::ffff:192.0.2.1'), '192.0.2.1');
  assert.ok(isLoopback('::1'));
  assert.ok(isLan('192.168.4.2'));
  assert.ok(isLan('fd00::1'));
  assert.ok(!isLan('8.8.8.8'));
  const old = process.env.WP_TEST_NO_EXEMPT;
  process.env.WP_TEST_NO_EXEMPT = '1';
  try {
    const g = new Guard({ maxStrikes: 2, maxConnPerIp: 1 });
    const a = Object.assign(new EventEmitter(), { remoteAddress: '203.0.113.4' });
    const b = Object.assign(new EventEmitter(), { remoteAddress: '203.0.113.4' });
    assert.ok(g.admit(a)); assert.ok(!g.admit(b)); a.emit('close'); assert.ok(g.admit(b));
    g.strike('203.0.113.4', 'bad'); g.strike('203.0.113.4', 'bad');
    assert.ok(g.isBlocked('203.0.113.4'));
    g.unblockAll(); assert.ok(!g.isBlocked('203.0.113.4'));
  } finally {
    if (old === undefined) delete process.env.WP_TEST_NO_EXEMPT; else process.env.WP_TEST_NO_EXEMPT = old;
  }
});

function request(port, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, host: '127.0.0.1', path: '/', method, headers }, res => {
      const chunks = [];
      res.on('data', x => chunks.push(x));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
}

test('media server supports full, HEAD, bounded, suffix, and invalid byte ranges', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-media-'));
  const file = path.join(dir, 'clip.mp4'), body = Buffer.from('0123456789');
  fs.writeFileSync(file, body);
  const { serveFile, contentTypeFor, authorizeHlsPlaylist } = require('../server/media');
  assert.equal(contentTypeFor(file), 'video/mp4');
  assert.equal(contentTypeFor('segment.m4s'), 'video/iso.segment');
  assert.equal(contentTypeFor('x.bin'), 'application/octet-stream');
  assert.equal(authorizeHlsPlaylist('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\nseg-00000.m4s\n', 'k=room&c=viewer'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4?k=room&c=viewer"\nseg-00000.m4s?k=room&c=viewer\n');
  const server = http.createServer((req, res) => serveFile(req, res, file, { maxChunk: 3 }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const port = server.address().port;
  let r = await request(port); assert.equal(r.status, 200); assert.deepEqual(r.body, body);
  r = await request(port, {}, 'HEAD'); assert.equal(r.status, 200); assert.equal(r.body.length, 0); assert.equal(r.headers['content-length'], '10');
  r = await request(port, { Range: 'bytes=2-' }); assert.equal(r.status, 206); assert.equal(r.body.toString(), '234'); assert.equal(r.headers['content-range'], 'bytes 2-4/10');
  r = await request(port, { Range: 'bytes=-2' }); assert.equal(r.body.toString(), '89');
  r = await request(port, { Range: 'bytes=20-30' }); assert.equal(r.status, 416); assert.equal(r.headers['content-range'], 'bytes */10');
});

test('prepare builds and cleans a native Safari HLS package', async t => {
  const ffmpeg = path.join(APP_ROOT, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const ffprobe = path.join(APP_ROOT, 'bin', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  if (!fs.existsSync(ffmpeg)) return t.skip('bundled ffmpeg is not available on this platform');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-hls-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source.mp4');
  const made = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=26',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0', '-t', '26', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '288', '-keyint_min', '288', '-sc_threshold', '0',
    '-c:a:0', 'ac3', '-c:a:1', 'aac', '-disposition:a:0', '0', '-disposition:a:1', 'default', source], { encoding: 'utf8', windowsHide: true });
  assert.equal(made.status, 0, made.stderr);
  const encoders = spawnSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8', windowsHide: true }).stdout;
  const audioEncoder = /\baac_mf\b/.test(encoders) ? 'aac_mf' : 'aac';
  const { Library } = require('../server/library');
  const library = new Library({ config: { cacheDir: dir, folders: [] }, tools: { ffmpeg, encoders: { h264: 'libx264', aac: audioEncoder } }, save() {} });
  const id = 'a1b2c3d4e5f6';
  const size = fs.statSync(source).size;
  library.items.set(id, { id, path: source, rel: 'source.mp4', title: 'Source', ext: '.mp4', size, info: {
    duration: 26, bitrateMbps: 1, video: { index: 0, codec: 'h264', width: 320, height: 180, bitDepth: 8, pixFmt: 'yuv420p' },
    audios: [{ index: 1, codec: 'ac3', channels: 2 }, { index: 2, codec: 'aac', channels: 2 }], defaultAudioIndex: 1, subs: [], plan: { mode: 'remux', reasons: [] },
  }, prepared: null, job: null });
  let liveDuringPrepare = null, livePlaylist = null, readyInList = false;
  library.once('ready', () => {
    liveDuringPrepare = library.playable(id);
    livePlaylist = library.hlsFile(id, 'index.m3u8');
    readyInList = library.list().items.find(item => item.id === id)?.job?.ready;
  });
  const job = library.prepare(id, { hls: true });
  while (['queued', 'running'].includes(job.state)) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(job.state, 'done', job.error);
  assert.equal(liveDuringPrepare?.progressive, true);
  assert.equal(liveDuringPrepare?.file, null);
  assert.equal(liveDuringPrepare?.hls, true);
  assert.ok(livePlaylist?.endsWith(`${id}.hls.part${path.sep}index.m3u8`));
  assert.equal(readyInList, true);
  const playable = library.playable(id);
  assert.equal(playable.hls, true);
  const playlistFile = library.hlsFile(id, 'index.m3u8');
  assert.ok(playlistFile);
  const playlist = fs.readFileSync(playlistFile, 'utf8');
  assert.match(playlist, /URI="init\.mp4"/);
  assert.match(playlist, /seg-00000\.m4s/);
  assert.doesNotMatch(playlist, /[A-Z]:[\\/]/i);
  const probed = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'json', playlistFile], { encoding: 'utf8', windowsHide: true });
  assert.equal(probed.status, 0, probed.stderr);
  assert.deepEqual(JSON.parse(probed.stdout).streams.map(stream => stream.codec_name), ['h264', 'aac']);
  const direct = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name,channels', '-of', 'json', playable.file], { encoding: 'utf8', windowsHide: true });
  assert.equal(direct.status, 0, direct.stderr);
  assert.deepEqual(JSON.parse(direct.stdout).streams.map(stream => stream.codec_name), ['h264', 'aac']);
  // ffmpeg's HLS demuxer used to start the MP4's audio one segment late (10 s on real movies)
  const starts = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,start_time', '-of', 'json', playable.file], { encoding: 'utf8', windowsHide: true });
  const [videoStart, audioStart] = JSON.parse(starts.stdout).streams.map(stream => Number(stream.start_time));
  assert.ok(Math.abs(audioStart - videoStart) < 0.1, `audio starts ${audioStart}s, video ${videoStart}s`);
  assert.equal(fs.existsSync(path.join(dir, `${id}.hls`, 'segments.txt')), false);
  assert.ok(library.hlsFile(id, 'init.mp4'));
  assert.equal(library.hlsFile(id, '../source.mp4'), null);
  library.removePrepared(id);
  assert.equal(fs.existsSync(path.join(dir, `${id}.hls`)), false);
});

test('Safari HLS is opt-in, maps the selected source audio, and strips Dolby Vision', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-prepare-options-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { Library, buildHlsArgs } = require('../server/library');
  const library = new Library({ config: { cacheDir: dir, folders: [] }, tools: { ffmpeg: 'ffmpeg', encoders: {} }, save() {} });
  library.running = {}; // Keep this unit test from starting the queued fake ffmpeg job.
  const id = 'a1b2c3d4e5f6';
  const info = {
    duration: 60, video: { index: 2, codec: 'hevc', dv: { profile: 8 } },
    audios: [{ index: 3, codec: 'dts', channels: 6 }, { index: 4, codec: 'aac', channels: 2 }],
    defaultAudioIndex: 4, subs: [{ index: 5, text: true }], plan: { mode: 'direct', reasons: [] },
  };
  library.items.set(id, { id, path: path.join(dir, 'source.mp4'), size: 1000, info, job: null });
  const job = library.prepare(id, {});
  assert.equal(job.opts.hls, false);
  library.cancel(id);

  const args = buildHlsArgs({ source: 'source.mp4', info, options: { subsOnly: true, audio: info.audios[1] }, videoCodec: 'hevc', stripDv: true, copyAudio: true });
  const maps = args.flatMap((arg, i) => arg === '-map' ? [args[i + 1]] : []);
  assert.deepEqual(maps, ['0:2', '0:4']);
  assert.equal(args[args.indexOf('-bsf:v') + 1], 'dovi_rpu=strip=1,hevc_mp4toannexb,extract_extradata');
  assert.equal(args[args.indexOf('-c:a') + 1], 'copy');
  assert.equal(args[args.indexOf('-hls_playlist_type') + 1], 'event');
  assert.equal(args[args.indexOf('-hls_flags') + 1], 'independent_segments+temp_file');
  const hevcCopyArgs = buildHlsArgs({ source: 'source.mkv', info, options: { subsOnly: true, audio: info.audios[1] }, videoCodec: 'hevc', stripDv: false, copyAudio: true });
  assert.equal(hevcCopyArgs[hevcCopyArgs.indexOf('-bsf:v') + 1], 'hevc_mp4toannexb,extract_extradata');

  const hlsDir = path.join(dir, `${id}.hls`);
  fs.mkdirSync(hlsDir); fs.writeFileSync(path.join(hlsDir, 'index.m3u8'), '#EXTM3U\n');
  const item = library.items.get(id);
  item.prepared = { hls: { dir: `${id}.hls` } };
  assert.equal(library.goodHls(item), null);
  item.prepared.hls.dvStripped = true;
  assert.ok(library.goodHls(item));
});

test('HLS audio copy is explicit and never bypasses stereo or six-channel limits', () => {
  const { buildHlsArgs } = require('../server/library');
  const info = { video: { index: 0, codec: 'h264' } };
  const audioArgs = (audio, audioMode, copyAudio) => buildHlsArgs({
    source: 'source.mp4', info, options: { subsOnly: true, audio, audioMode },
    videoCodec: 'h264', stripDv: false, copyAudio,
  });
  const option = (args, name) => args[args.indexOf(name) + 1];

  const safeCopy = audioArgs({ index: 1, codec: 'aac', channels: 2 }, 'surround', true);
  assert.equal(option(safeCopy, '-c:a'), 'copy');
  assert.equal(safeCopy.includes('-ac'), false);

  const stereo = audioArgs({ index: 1, codec: 'aac', channels: 6 }, 'stereo', false);
  assert.equal(option(stereo, '-c:a'), 'aac');
  assert.equal(option(stereo, '-b:a'), '256k');
  assert.equal(option(stereo, '-ac'), '2');

  const compatibleSurround = audioArgs({ index: 1, codec: 'aac', channels: 8 }, 'surround', false);
  assert.equal(option(compatibleSurround, '-c:a'), 'aac');
  assert.equal(option(compatibleSurround, '-b:a'), '640k');
  assert.equal(option(compatibleSurround, '-ac'), '6');
});

test('progressive preparation really downmixes source AAC when stereo is requested', async t => {
  const ffmpeg = path.join(APP_ROOT, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const ffprobe = path.join(APP_ROOT, 'bin', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  if (!fs.existsSync(ffmpeg)) return t.skip('bundled ffmpeg is not available on this platform');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-hls-audio-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source.mp4');
  const made = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=24:duration=5',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=5.1', '-t', '5',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
    '-c:a', 'aac', source], { encoding: 'utf8', windowsHide: true });
  assert.equal(made.status, 0, made.stderr);

  const { Library } = require('../server/library');
  const id = 'b1c2d3e4f5a6';
  const library = new Library({ config: { cacheDir: dir, folders: [] }, tools: { ffmpeg, encoders: { aac: 'aac' } }, save() {} });
  library.items.set(id, { id, path: source, rel: 'source.mp4', title: 'Source', ext: '.mp4', size: fs.statSync(source).size,
    info: { duration: 5, bitrateMbps: 1, video: { index: 0, codec: 'h264', width: 160, height: 90, bitDepth: 8, pixFmt: 'yuv420p' },
      audios: [{ index: 1, codec: 'aac', channels: 6 }], defaultAudioIndex: 1, subs: [], plan: { mode: 'remux', reasons: [] } },
    prepared: null, job: null });
  const job = library.prepare(id, { hls: true, audioMode: 'stereo' });
  while (['queued', 'running'].includes(job.state)) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(job.state, 'done', job.error);
  for (const file of [library.hlsFile(id, 'index.m3u8'), library.playable(id).file]) {
    const result = spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,channels', '-of', 'json', file], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).streams[0], { codec_name: 'aac', channels: 2 });
  }
});

test('self-signed certificates are valid, cover requested hosts, and are reused', () => {
  const { X509Certificate } = crypto;
  const { makeCert, loadOrCreate } = require('../server/cert');
  const made = makeCert({ ips: ['192.168.1.5'], names: ['watch.local'], days: 30 });
  const x = new X509Certificate(made.cert);
  assert.match(x.subjectAltName, /DNS:localhost/);
  assert.match(x.subjectAltName, /DNS:watch\.local/);
  assert.match(x.subjectAltName, /IP Address:192\.168\.1\.5/);
  require('node:tls').createSecureContext({ cert: made.cert, key: made.key });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-cert-')), file = path.join(dir, 'cert.json');
  const first = loadOrCreate(file, ['10.0.0.2']), second = loadOrCreate(file, ['10.0.0.2']);
  assert.equal(second.cert, first.cert);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('assets reject traversal and YouTube result parsing survives both layouts', () => {
  const assets = require('../server/assets');
  assert.match(assets.get('index.html').type, /text\/html/);
  const hls = assets.get('vendor/hls.min.js');
  assert.match(hls.type, /javascript/);
  assert.deepEqual(hls.body, fs.readFileSync(path.join(ROOT, 'node_modules/hls.js/dist/hls.light.min.js')));
  assert.ok(assets.get('vendor/hls.LICENSE.txt').body.length > 100);
  assert.match(read('build/build-windows.js'), /assets\['public\/vendor\/hls\.min\.js'\]/);
  for (const p of ['', '../config.json', 'js/../index.html', 'js//app.js']) assert.equal(assets.get(p), null, p);
  const { parsePage } = require('../server/youtube');
  const data = { a: { videoRenderer: { videoId: 'abcdefghijk', title: { simpleText: 'One' }, ownerText: { runs: [{ text: 'Channel' }] }, lengthText: { simpleText: '1:23' }, thumbnail: { thumbnails: [{ url: 'https://img/1' }] } } }, b: { lockupViewModel: { contentId: 'lmnopqrstuv', contentType: 'VIDEO', metadata: { lockupMetadataViewModel: { title: { content: 'Two' } } } } } };
  const out = parsePage(`<script>var ytInitialData = ${JSON.stringify(data)};</script>`);
  assert.deepEqual(out.map(x => x.id), ['abcdefghijk', 'lmnopqrstuv']);
  assert.equal(out[0].title, 'One');
});

test('library analysis preserves direct, remux, transcode, title, and audio decisions', () => {
  const { analyze, computePlan, cleanTitle, audioLabel } = require('../server/library');
  assert.equal(cleanTitle('Some.Movie.2024.2160p.REMUX.mkv'), 'Some Movie (2024)');
  assert.equal(audioLabel({ codec: 'truehd', title: 'Atmos', channels: 8 }), 'TrueHD Atmos 7.1');
  const base = { duration: 120, size: 1000, bitrateMbps: 1, container: 'mov,mp4', video: { codec: 'h264', bitDepth: 8, pixFmt: 'yuv420p' }, audios: [{ index: 1, codec: 'aac', channels: 2 }], defaultAudioIndex: 1 };
  assert.equal(computePlan(base, '.mp4').mode, 'direct');
  assert.equal(computePlan({ ...base, container: 'matroska' }, '.mkv').mode, 'remux');
  assert.equal(computePlan({ ...base, video: { codec: 'vc1', bitDepth: 8, pixFmt: 'yuv420p' } }, '.mkv').mode, 'transcode');
  const info = analyze({ format: { duration: '10', size: '1000', format_name: 'mov,mp4' }, streams: [{ index: 0, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, pix_fmt: 'yuv420p' }, { index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, disposition: { default: 1 } }] }, { size: 1000, ext: '.mp4' });
  assert.equal(info.plan.mode, 'direct'); assert.equal(info.defaultAudioIndex, 1);
});
