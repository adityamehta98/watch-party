'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : path.join(dir, e.name));

test('every JavaScript file parses', () => {
  for (const dir of ['server', 'public/js', 'extension', 'apple/SafariWebExtension', 'build', 'test']) {
    for (const file of walk(path.join(ROOT, dir)).filter(f => f.endsWith('.js'))) {
      const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${path.relative(ROOT, file)}: ${r.stderr}`);
    }
  }
});

test('browser DOM and icon references resolve', () => {
  const page = read('public/index.html');
  const app = read('public/js/app.js');
  const ids = new Set([...`${page}\n${app}`.matchAll(/\bid=["']([^"']+)/g)].map(m => m[1]));
  const used = [...app.matchAll(/(?:\$\(['"]#|getElementById\(['"])([\w-]+)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(used.filter(id => !ids.has(id)))], []);
  const symbols = new Set([...page.matchAll(/<symbol\s+id="i-([^"]+)/g)].map(m => m[1]));
  const icons = [...app.matchAll(/\bicon\(['"]([^'"]+)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(icons.filter(name => !symbols.has(name)))], []);

  for (const [htmlFile, jsFile] of [['extension/sidebar.html', 'extension/sidebar.js'], ['extension/theater.html', 'extension/theater.js']]) {
    const html = read(htmlFile), js = read(jsFile);
    const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)/g)].map(m => m[1]));
    const jsIds = [...js.matchAll(/(?:\$\(['"]#|getElementById\(['"])([\w-]+)/g)].map(m => m[1]);
    assert.deepEqual([...new Set(jsIds.filter(id => !htmlIds.has(id)))], [], jsFile);
  }
});

test('manifest and HTML local assets exist and extension versions agree', () => {
  const manifest = JSON.parse(read('extension/manifest.json'));
  const safari = JSON.parse(read('apple/SafariWebExtension/manifest.json'));
  const refs = [manifest.background.service_worker, manifest.side_panel.default_path,
    ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon),
    ...manifest.content_scripts.flatMap(x => [...(x.js || []), ...(x.css || [])])];
  for (const rel of new Set(refs)) assert.ok(fs.existsSync(path.join(ROOT, 'extension', rel)), rel);
  assert.equal(/REQUIRED_EXT_VERSION = '([^']+)'/.exec(read('public/js/media.js'))[1], manifest.version);
  assert.equal(safari.version, manifest.version);
  const safariRefs = [safari.background.service_worker, safari.action.default_popup,
    ...Object.values(safari.icons), ...Object.values(safari.action.default_icon),
    ...safari.content_scripts.flatMap(x => [...(x.js || []), ...(x.css || [])])];
  for (const rel of new Set(safariRefs)) assert.ok(fs.existsSync(path.join(ROOT, 'apple/SafariWebExtension', rel)) || fs.existsSync(path.join(ROOT, 'extension', rel)), `Safari: ${rel}`);
  for (const html of ['public/index.html', 'extension/sidebar.html', 'extension/theater.html']) {
    const dir = path.dirname(path.join(ROOT, html));
    for (const m of read(html).matchAll(/(?:src|href)="([^"#]+)"/g)) {
      if (!/^(?:https?:|\/)/.test(m[1])) assert.ok(fs.existsSync(path.resolve(dir, m[1])), `${html}: ${m[1]}`);
    }
  }
});

function unzipEntries(file) {
  const b = fs.readFileSync(file);
  let end = b.length - 22;
  while (end >= 0 && b.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0, 'zip end record');
  const count = b.readUInt16LE(end + 10), out = new Map();
  let at = b.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(b.readUInt32LE(at), 0x02014b50);
    const method = b.readUInt16LE(at + 10), compressed = b.readUInt32LE(at + 20);
    const nameLen = b.readUInt16LE(at + 28), extraLen = b.readUInt16LE(at + 30), commentLen = b.readUInt16LE(at + 32);
    const name = b.toString('utf8', at + 46, at + 46 + nameLen), local = b.readUInt32LE(at + 42);
    if (!name.endsWith('/')) {
      const localName = b.readUInt16LE(local + 26), localExtra = b.readUInt16LE(local + 28);
      const start = local + 30 + localName + localExtra, data = b.subarray(start, start + compressed);
      out.set(name, method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data));
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

test('downloadable extension is byte-identical to extension source', () => {
  const zip = unzipEntries(path.join(ROOT, 'public/ext/watch-party-sync.zip'));
  const files = walk(path.join(ROOT, 'extension'));
  assert.equal(zip.size, files.length);
  for (const file of files) {
    const rel = path.relative(path.join(ROOT, 'extension'), file).replaceAll('\\', '/');
    const packed = zip.get(`watch-party-sync/${rel}`);
    assert.ok(packed, `${rel} missing from extension ZIP`);
    assert.deepEqual(packed, fs.readFileSync(file), rel);
  }
});

test('Safari source ZIP is the common extension plus its audited overlay', () => {
  const zip = unzipEntries(path.join(ROOT, 'public/ext/watch-party-safari-source.zip'));
  const expected = new Map();
  for (const base of ['extension', 'apple/SafariWebExtension']) {
    for (const file of walk(path.join(ROOT, base))) {
      const rel = path.relative(path.join(ROOT, base), file).replaceAll('\\', '/');
      expected.set(rel, fs.readFileSync(file));
    }
  }
  assert.equal(zip.size, expected.size);
  for (const [rel, source] of expected) {
    const packed = zip.get(`watch-party-safari/${rel}`);
    assert.ok(packed, `${rel} missing from Safari ZIP`);
    assert.deepEqual(packed, source, rel);
  }
});

test('Safari release tooling validates identifiers without storing signing data', () => {
  const { parseOptions } = require('../build/build-safari-xcode');
  assert.deepEqual(parseOptions(['--bundle-id', 'com.example.WatchPartySync', '--ios-only'], {}), { bundleId: 'com.example.WatchPartySync', platform: '--ios-only' });
  assert.throws(() => parseOptions(['--bundle-id', 'not-valid'], {}), /reverse-DNS/);
  assert.throws(() => parseOptions(['--bundle-id', 'com.example.App', '--ios-only', '--macos-only'], {}), /only one/);
  const workflow = read('.github/workflows/safari-package.yml');
  assert.match(workflow, /permissions:\s*\n\s*contents: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /secrets\./);
  const nativeClient = read('apple/WatchPartyKit/Sources/WatchPartyKit/RoomClient.swift');
  assert.match(nativeClient, /URLSessionConfiguration\.ephemeral/);
  assert.doesNotMatch(nativeClient, /UserDefaults|Keychain|serverTrust|credential/);
  for (const file of ['Models.swift', 'RoomClient.swift', 'ApplePlayer.swift', 'SharePlay.swift', 'CompanionView.swift']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'apple/WatchPartyKit/Sources/WatchPartyKit', file)), file);
  }
});

test('extension archives are byte-reproducible', () => {
  const { archiveDirectory } = require('../build/build-safari-extension');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-zip-')), source = path.join(root, 'extension');
  try {
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'manifest.json'), '{"name":"test"}\n');
    const first = path.join(root, 'first.zip'), second = path.join(root, 'second.zip');
    archiveDirectory(root, 'extension', first);
    fs.utimesSync(path.join(source, 'manifest.json'), new Date(), new Date());
    archiveDirectory(root, 'extension', second);
    assert.deepEqual(fs.readFileSync(first), fs.readFileSync(second));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('device detection selects the correct extension installation path', async () => {
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(read('public/js/platform.js')).toString('base64')}`;
  const { detectPlatform, installTarget } = await import(moduleUrl);
  const ipad = detectPlatform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1', platform: 'MacIntel', maxTouchPoints: 5 });
  assert.equal(ipad.device, 'iPad'); assert.equal(ipad.safari, true); assert.equal(installTarget(ipad), 'apple-mobile-unpublished'); assert.equal(installTarget(ipad, 'https://testflight.apple.com/join/abc'), 'apple-mobile');
  const iphoneChrome = detectPlatform({ userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 CriOS/130.0 Mobile/15E148 Safari/604.1' });
  assert.equal(iphoneChrome.iphone, true); assert.equal(iphoneChrome.safari, false); assert.equal(installTarget(iphoneChrome, 'https://apps.apple.com/app/id1'), 'apple-mobile-browser');
  const mac = detectPlatform({ userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 0 });
  assert.equal(installTarget(mac), 'mac-safari-source');
  const windows = detectPlatform({ userAgent: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36' });
  assert.equal(installTarget(windows), 'chromium');
  assert.doesNotMatch(read('public/js/app.js'), /Phones and tablets can't run extensions/);
});

test('adaptive sync tuning protects weak buffers without hiding large drift', async () => {
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(read('public/js/sync.js')).toString('base64')}`;
  const { syncTuning } = await import(moduleUrl);
  assert.equal(syncTuning({ drift: -0.2, ahead: 8 }).hardSeek, 0.9);
  assert.equal(syncTuning({ drift: -0.2, ahead: 1 }).hardSeek, 1.15);
  assert.equal(syncTuning({ drift: -0.2, ahead: 1 }).maxRateDelta, 0.025);
  assert.equal(syncTuning({ drift: 0.3, ahead: 8 }).maxRateDelta, 0.1);
  assert.equal(syncTuning({ rtt: 900 }).softEps, 0.08);
});

test('synchronization benchmark results and README badge are reproducible', () => {
  const result = spawnSync(process.execPath, ['benchmark/sync-benchmark.js', '--check'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const measured = JSON.parse(read('benchmark/results.json'));
  assert.ok(measured.samples > 100000);
  assert.ok(measured.p50Ms <= measured.p95Ms && measured.p95Ms <= measured.p99Ms);
  assert.match(read('README.md'), /\.github\/badges\/sync\.svg/);
});

test('visual policy disables costly effects for accessibility and constrained devices', async () => {
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(read('public/js/visuals.js')).toString('base64')}`;
  const { visualPolicy } = await import(moduleUrl);
  assert.deepEqual(visualPolicy({}), { ambient: true, motion: true, saver: false, reasons: [] });
  assert.equal(visualPolicy({ reducedMotion: true }).ambient, false);
  assert.equal(visualPolicy({ reducedMotion: true }).motion, false);
  assert.equal(visualPolicy({ saveData: true }).saver, true);
  assert.equal(visualPolicy({ batteryLevel: .15, charging: false }).ambient, false);
  assert.equal(visualPolicy({ batteryLevel: .15, charging: true }).ambient, true);
  assert.equal(visualPolicy({ deviceMemory: 4 }).ambient, false);
  assert.equal(visualPolicy({ forcedSaver: true }).motion, false);
});

test('visual effects are local, bounded, and compositor-friendly', () => {
  const app = read('public/js/app.js'), room = read('server/room.js');
  assert.match(app, /kindOf\(S\.movie\) === 'file'/);
  assert.match(app, /document\.visibilityState === 'visible'/);
  assert.doesNotMatch(app, /ambientCanvas\.(?:toDataURL|toBlob)/);
  assert.match(room, /kind: 'knock'.*name, clientId/);
  for (const body of app.matchAll(/\.animate\(\[([\s\S]*?)\],\s*\{/g)) assert.doesNotMatch(body[1], /(?:width|height|top|left|background|filter)\s*:/);
});

test('PWA shell is installable without caching room secrets or media', () => {
  const { manifest } = require('../server/pwa');
  const m = manifest('/join/abc123');
  assert.equal(m.start_url, '/join/abc123');
  assert.equal(m.display, 'standalone');
  assert.ok(m.icons.some(icon => icon.sizes === '512x512' && icon.purpose.includes('maskable')));
  assert.throws(() => manifest('/join/not-valid!'));
  const sw = read('public/sw.js');
  for (const forbidden of ['/join/', '/host/', '/media/', '/api/', 'index.html', 'manifest.webmanifest']) assert.doesNotMatch(sw, new RegExp(`['\"]${forbidden.replaceAll('/', '\\/')}`));
  assert.match(sw, /const cacheKey = url\.pathname/);
  assert.match(read('server/index.js'), /manifest\.webmanifest[\s\S]*private, no-store/);
  assert.doesNotMatch(read('public/favicon.svg'), /<metadata|xmlns:[\w-]+=/i);
});

test('playback capabilities choose native HLS with a direct-file fallback', async () => {
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(read('public/js/capabilities.js')).toString('base64')}`;
  const { playbackCapabilities, deliverySources } = await import(moduleUrl);
  const safari = playbackCapabilities({ canPlayType: type => type.includes('mpegurl') ? 'maybe' : '' }, {});
  assert.deepEqual(safari, { hls: true, mse: false });
  const movie = { url: '/media/abc/video', hls: '/media/abc/hls/index.m3u8' };
  assert.deepEqual(deliverySources(movie, safari, 'room key', 'viewer'), [
    '/media/abc/hls/index.m3u8?k=room+key&c=viewer',
    '/media/abc/video?k=room+key&c=viewer',
  ]);
  assert.deepEqual(deliverySources(movie, { hls: false }, 'key', 'viewer'), ['/media/abc/video?k=key&c=viewer']);
});

test('Apple extension links are restricted to App Store and TestFlight HTTPS URLs', () => {
  const { cleanAppleExtensionUrl } = require('../server/settings');
  assert.equal(cleanAppleExtensionUrl('https://testflight.apple.com/join/AbCd1234'), 'https://testflight.apple.com/join/AbCd1234');
  assert.equal(cleanAppleExtensionUrl('https://apps.apple.com/us/app/watch-party/id123'), 'https://apps.apple.com/us/app/watch-party/id123');
  for (const url of ['http://apps.apple.com/app/id1', 'https://apps.apple.com.evil.test/app', 'javascript:alert(1)', 'https://example.com/app']) assert.equal(cleanAppleExtensionUrl(url), '', url);
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
  const ffmpeg = path.join(ROOT, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (!fs.existsSync(ffmpeg)) return t.skip('bundled ffmpeg is not available on this platform');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-hls-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source.mp4');
  const made = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=1', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source], { encoding: 'utf8', windowsHide: true });
  assert.equal(made.status, 0, made.stderr);
  const { Library } = require('../server/library');
  const library = new Library({ config: { cacheDir: dir, folders: [] }, tools: { ffmpeg, encoders: { h264: 'libx264' } }, save() {} });
  const id = 'a1b2c3d4e5f6';
  const size = fs.statSync(source).size;
  library.items.set(id, { id, path: source, rel: 'source.mp4', title: 'Source', ext: '.mp4', size, info: {
    duration: 1, bitrateMbps: 1, video: { index: 0, codec: 'h264', width: 320, height: 180, bitDepth: 8, pixFmt: 'yuv420p' },
    audios: [{ index: 1, codec: 'aac', channels: 2 }], defaultAudioIndex: 1, subs: [], plan: { mode: 'direct', reasons: [] },
  }, prepared: null, job: null });
  const job = library.prepare(id, { hls: true });
  while (['queued', 'running'].includes(job.state)) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(job.state, 'done', job.error);
  const playable = library.playable(id);
  assert.equal(playable.hls, true);
  const playlistFile = library.hlsFile(id, 'index.m3u8');
  assert.ok(playlistFile);
  const playlist = fs.readFileSync(playlistFile, 'utf8');
  assert.match(playlist, /URI="init\.mp4"/);
  assert.match(playlist, /seg-00000\.m4s/);
  assert.doesNotMatch(playlist, /[A-Z]:[\\/]/i);
  assert.ok(library.hlsFile(id, 'init.mp4'));
  assert.equal(library.hlsFile(id, '../source.mp4'), null);
  library.removePrepared(id);
  assert.equal(fs.existsSync(path.join(dir, `${id}.hls`)), false);
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

test('room keys, permissions, URL selection, public data, and timeline commands work', t => {
  const { Room, randKey, PERMS, REACTIONS } = require('../server/room');
  assert.match(randKey(24), /^[A-Za-z0-9]{24}$/); assert.equal(new Set(PERMS).size, 4); assert.ok(REACTIONS.includes('👏'));
  const library = { playable: id => id === 'movie' ? { id, title: 'Movie', file: 'D:\\private\\movie.mp4', duration: 100, subs: [] } : null, list: () => ({ folders: ['D:\\private'], scanning: false, items: [{ id: 'movie', rel: 'secret\\movie.mp4' }] }) };
  const room = new Room({ config: { adminKey: 'admin-secret-key', roomKey: 'guestsecretkey1234', safariExtensionUrl: 'https://testflight.apple.com/join/AbCd1234', room: {} }, library, save() {} });
  t.after(() => room.shutdown());
  assert.equal(room.roleForKey('admin-secret-key', true), 'host');
  assert.equal(room.roleForKey('admin-secret-key', false), null);
  assert.equal(room.roleForKey('guestsecretkey1234'), 'guest');
  const host = { id: 'host01', name: 'Host', role: 'host', admitted: true, perms: Object.fromEntries(PERMS.map(p => [p, true])), ws: { readyState: 0 } };
  room.selectMovie(host, 'movie');
  assert.equal(room.publicMovie().file, undefined); assert.equal(room.publicMovie().url, '/media/movie/video');
  room.command(host, { action: 'seek', position: 500 }); assert.equal(room.state.position, 100);
  room.selectUrl(host, 'http://127.0.0.1/private', false, { custom: true }); assert.equal(room.movie.kind, 'file');
  room.selectUrl(host, 'https://example.com/watch?ep=2', false, { custom: true, strict: true });
  assert.equal(room.movie.service, 'custom'); assert.equal(room.movie.strict, true);
  assert.equal(room.guestLibrary().folders[0], '(the host\'s movies)'); assert.equal(room.guestLibrary().items[0].rel, 'movie.mp4');
  assert.equal(room.publicSettings(false).safariExtensionUrl, 'https://testflight.apple.com/join/AbCd1234');
});

test('Sync Observatory keeps bounded in-memory health, corrections, and recommendations', t => {
  const { Room } = require('../server/room');
  const config = { adminKey: 'admin-secret-key', roomKey: 'guestsecretkey1234', room: { autoWait: false } };
  const room = new Room({ config, library: { list: () => ({ folders: [], scanning: false, items: [] }) }, save() {} });
  t.after(() => room.shutdown());
  room.movie = { id: 'movie', kind: 'file', title: 'Movie', duration: 3600, height: 1080, mbps: 12 };
  room.state = { movieId: 'movie', playing: false, position: 120, anchor: Date.now(), seq: 1, waiting: false, waitingFor: [] };
  const guest = { id: 'alex01', name: 'Alex', role: 'guest', admitted: true, perms: {}, ws: { readyState: 0 }, status: { at: 0 }, bufferingSince: null, lastWaitCause: 0, metrics: { corrections: [], lastCorrection: '' }, mbps: 6, bytes: 0, lastBytes: 0 };
  room.clients.set(guest.id, guest);
  room.onMessage(guest, { type: 'status', status: { loaded: true, ready: false, buffering: true, health: 8, rtt: 240, drift: -420, stalls: 3, rate: 1, correction: { id: 1, type: 'seek', drift: -420, at: Date.now(), value: 120 } } });
  room.onMessage(guest, { type: 'status', status: { loaded: true, ready: true, buffering: false, health: 45, rtt: 180, drift: -35, stalls: 3, rate: 1.02, correction: { id: 2, type: 'rate', drift: -35, at: Date.now(), value: 1.02 } } });
  const obs = room.observatory();
  assert.ok(obs.confidence >= 0 && obs.confidence <= 100);
  assert.deepEqual(obs.timeline.map(e => e.type), ['stall', 'recover']);
  assert.match(obs.recommendations[0].text, /720p.*Alex.*buffering/);
  const publicGuest = room.people(true).find(p => p.id === guest.id);
  assert.equal(publicGuest.status.corrections.length, 2);
  assert.equal(config.syncEvents, undefined); assert.equal(config.metrics, undefined);
});

test('room moments anchor chat, reactions, and bookmarks to movie time in memory', t => {
  const { Room, REACTIONS } = require('../server/room');
  const room = new Room({ config: { adminKey: 'admin-secret-key', roomKey: 'guestsecretkey1234', room: {} }, library: { list: () => ({ folders: [], scanning: false, items: [] }) }, save() {} });
  t.after(() => room.shutdown());
  room.movie = { id: 'movie', kind: 'file', title: 'Movie', duration: 100, subs: [] };
  room.state = { movieId: 'movie', playing: false, position: 42.25, anchor: Date.now(), seq: 1, waiting: false, waitingFor: [] };
  const sent = [];
  room.broadcast = message => sent.push(message);
  const guest = { id: 'viewer1', name: 'Alex', role: 'guest', admitted: true, perms: { playback: true, chat: true, react: true }, ws: { readyState: 0 }, lastReact: [] };
  room.onMessage(guest, { type: 'chat', text: 'Great scene' });
  assert.equal(sent.at(-1).message.movieId, 'movie');
  assert.equal(sent.at(-1).message.position, 42.3);
  room.onMessage(guest, { type: 'react', emoji: REACTIONS[0] });
  assert.equal(sent.at(-1).movieId, 'movie');
  assert.equal(sent.at(-1).position, 42.3);
  assert.ok(sent.at(-1).at >= Date.now() - 20);
  room.onMessage(guest, { type: 'bookmark', label: '<Finale>' });
  assert.equal(room.bookmarks.length, 1);
  assert.equal(room.bookmarks[0].label, 'Finale');
  assert.equal(sent.at(-1).type, 'bookmarks');
  assert.equal(room.config.bookmarks, undefined);
});

test('tool, UPnP, tunnel, and TURN helpers retain expected behavior', async t => {
  const tools = require('../server/tools');
  assert.equal(tools.encoderLabel('hevc_nvenc'), 'NVIDIA GPU'); assert.equal(tools.encoderLabel(null), 'none');
  assert.deepEqual(await tools.detectEncoders(null), { hevc: null, h264: null, hevcSoftware: false, h264Software: false, list: [] });
  assert.equal(await tools.hasDoviStrip(null), false);
  const ran = await tools.run(process.execPath, ['-e', 'process.stdout.write("ok")']); assert.equal(ran.code, 0); assert.equal(ran.out, 'ok');
  const { isPrivate, PortMapper } = require('../server/upnp');
  assert.ok(isPrivate('100.64.0.1')); assert.ok(!isPrivate('8.8.8.8')); assert.equal(new PortMapper().state.status, 'idle');
  const { Tunnel } = require('../server/tunnel'); assert.equal(new Tunnel(null, 8765).status, 'missing');
  const { TurnServer } = require('../server/turn');
  const turn = new TurnServer({ port: 0, username: 'u', password: 'p', localIps: ['10.0.0.2'] });
  assert.equal(turn.advertisedIp(), '10.0.0.2'); assert.ok(turn.isOurIp('127.0.0.1'));
  await turn.start(); t.after(() => turn.stop()); assert.ok(turn.sock.address().port > 0);
});

test('legacy Cloudflare settings are cleaned and launcher docs are accurate', () => {
  const { migrateConfig } = require('../server/settings');
  const migrated = migrateConfig({ bind: '127.0.0.1', tunnel: 'cloudflare', iceServers: ['stun:old.example'], safariExtensionUrl: 'javascript:alert(1)' });
  assert.equal(migrated.bind, undefined);
  assert.equal(migrated.tunnel, undefined);
  assert.equal(migrated.iceServers, undefined);
  assert.equal(migrated.safariExtensionUrl, '');
  assert.equal(migrated.version, 2);
  assert.equal(migrateConfig({ version: 2, tunnel: 'cloudflare' }).tunnel, 'cloudflare');
  assert.doesNotMatch(read('bin/README.txt'), /installed by refresh\.bat/i);
});

function event() { const listeners = []; return { addListener(fn) { listeners.push(fn); }, fire(...a) { return listeners.map(fn => fn(...a)); } }; }

test('custom-site extension installs scoped ad rules and preserves same-site popup buttons', async () => {
  const updates = [], removed = [], activated = [], timers = [];
  const runtimeMessage = event();
  const context = vm.createContext({ URL, URLSearchParams, console, self: {}, importScripts() {}, setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {}, chrome: {
    runtime: { id: 'ext', onConnect: event(), onMessage: runtimeMessage, getURL: p => `chrome-extension://ext/${p}` },
    sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
    tabs: { onRemoved: event(), onCreated: event(), query: async () => [], get: async () => ({}), update: async (id, x) => { activated.push([id, x]); }, remove: async id => { removed.push(id); }, sendMessage: async () => {}, create: async () => ({ id: 2 }) },
    webNavigation: { onCreatedNavigationTarget: event() }, scripting: { executeScript: async () => {} }, windows: { get: async () => ({}), update: async () => {} },
    declarativeNetRequest: { getSessionRules: async () => [], updateSessionRules: async x => { updates.push(x); } },
  } });
  vm.runInContext(read('extension/services.js'), context);
  vm.runInContext(read('extension/ad-domains.js'), context);
  vm.runInContext(read('extension/background.js'), context);
  assert.ok(context.self.WP_AD_DOMAINS.length >= 80);
  let reply;
  runtimeMessage.fire({ wp: 'theater-hello', party: 'https://party.example/join/key', custom: 'https://video.example/watch', blockPopups: true }, { tab: { id: 7 } }, x => { reply = x; });
  await new Promise(resolve => setImmediate(resolve));
  const rules = updates.at(-1).addRules;
  assert.equal(rules.map(r => r.id).join(','), '1,2,3');
  assert.equal(rules[2].action.type, 'block'); assert.ok(rules[2].condition.resourceTypes.includes('script')); assert.ok(rules[2].condition.resourceTypes.includes('media'));
  assert.equal(reply.ok, true);
  context.closeAdTab(20, 7, -1, 'https://cdn.video.example/next'); assert.equal(timers.length, 0);
  context.closeAdTab(21, 7, -1, 'https://popup.example/ad'); assert.equal(timers.at(-1).ms, 400);
  timers.at(-1).fn(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(removed, [21]); assert.equal(activated.at(-1)[0], 7);
  const theater = read('extension/theater.js');
  assert.match(theater, /removeAttribute\('sandbox'\)/); assert.doesNotMatch(read('extension/theater.html'), /\ssandbox=/);
  assert.doesNotMatch(`${read('extension/service.js')}\n${read('extension/custom-clean.js')}`, /window\.open\s*=/);
});

test('Safari opens streaming sites as normal top-level tabs', async () => {
  const runtimeConnect = event(), runtimeMessage = event(), partyMessage = event();
  const created = [], updated = [], rules = [];
  const context = vm.createContext({ URL, URLSearchParams, console, self: { WP_SAFARI: true }, importScripts() {}, setTimeout, clearTimeout, chrome: {
    runtime: { id: 'ext', onConnect: runtimeConnect, onMessage: runtimeMessage, getURL: p => `safari-web-extension://ext/${p}` },
    tabs: { onRemoved: event(), onCreated: event(), query: async () => [], get: async () => ({}), update: async (id, opts) => { updated.push([id, opts]); }, remove: async () => {}, sendMessage: async () => {}, create: async opts => { created.push(opts); return { id: 22, windowId: 3 }; } },
    webNavigation: { onCreatedNavigationTarget: event() }, scripting: { executeScript: async () => {} }, windows: { get: async () => ({}), update: async () => {} },
    declarativeNetRequest: { getSessionRules: async () => [], updateSessionRules: async update => { rules.push(update); } },
  } });
  vm.runInContext(read('extension/services.js'), context);
  vm.runInContext(read('extension/ad-domains.js'), context);
  vm.runInContext(read('extension/background.js'), context);
  const port = { name: 'party', sender: { tab: { id: 5, windowId: 3 }, frameId: 0 }, onMessage: partyMessage, onDisconnect: event(), postMessage() {} };
  runtimeConnect.fire(port);
  partyMessage.fire({ type: 'watch', service: 'netflix', url: 'https://www.netflix.com/watch/123', blockPopups: true });
  let reply;
  runtimeMessage.fire({ wp: 'theater-open', url: 'https://party.example/join/key' }, { tab: { id: 5 } }, value => { reply = value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(created.length, 1); assert.equal(created[0].url, 'https://www.netflix.com/watch/123');
  assert.equal(reply.ok, true); assert.equal(reply.safari, true);
  partyMessage.fire({ type: 'watch', service: 'custom', url: 'https://video.example/watch', blockPopups: true });
  let customReply;
  runtimeMessage.fire({ wp: 'theater-open', url: 'https://party.example/join/key' }, { tab: { id: 5 } }, value => { customReply = value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(created[1].url, 'about:blank');
  assert.equal(updated.at(-1)[0], 22); assert.equal(updated.at(-1)[1].url, 'https://video.example/watch');
  assert.ok(rules.at(-1).addRules.some(rule => rule.action.type === 'block'));
  assert.equal(customReply.ok, true); assert.equal(customReply.safari, true);
});

test('secret, authentication, and cleanup invariants remain enforced', () => {
  const ignored = read('.gitignore');
  for (const pattern of ['.env', 'credentials*.json', 'secrets*.json', '*.key', '*.pem', '*.p12', '*.pfx', '*.p8', '*.mobileprovision']) {
    assert.ok(ignored.split(/\r?\n/).includes(pattern), `${pattern} must stay ignored`);
  }

  const production = ['server', 'public', 'extension', 'apple', 'build', '.github'].flatMap(dir => walk(path.join(ROOT, dir)))
    .filter(file => !/\.(?:zip|png|ico|exe|dll)$/i.test(file));
  const secrets = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{30,255}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    /\bsk_live_[A-Za-z0-9]{16,}\b/,
    /\bAIza[0-9A-Za-z_-]{35}\b/,
    /https?:\/\/[^\s/@:]+:[^\s/@]+@/,
  ];
  for (const file of production) {
    const source = fs.readFileSync(file, 'utf8');
    for (const secret of secrets) assert.doesNotMatch(source, secret, path.relative(ROOT, file));
  }

  const index = read('server/index.js');
  assert.doesNotMatch(index, /searchParams\.get\(['"]admin['"]\)/);
  assert.match(index, /headers\['x-admin-key'\]/);
  assert.match(index, /FromBase64String/);
  assert.doesNotMatch(index, /-Message \$\{JSON\.stringify/);
  assert.ok(!fs.existsSync(path.join(ROOT, 'extension/popup.html')));
  assert.ok(!fs.existsSync(path.join(ROOT, 'extension/popup.js')));
  assert.doesNotMatch(`${read('public/css/app.css')}\n${read('README.md')}\n${read('bin/README.txt')}`, /tunnel-box|link-seg|tile\.speaking|Start Watch Party\.bat/);
});
