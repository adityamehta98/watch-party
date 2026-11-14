'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).filter(e => !(dir === path.join(ROOT, 'build') && ['cache', 'output'].includes(e.name))).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : path.join(dir, e.name));

test('every JavaScript file parses', () => {
  for (const dir of ['server', 'public/js', 'extension', 'build', 'test']) {
    for (const file of walk(path.join(ROOT, dir)).filter(f => f.endsWith('.js'))) {
      const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${path.relative(ROOT, file)}: ${r.stderr}`);
    }
  }
});

test('browser DOM and icon references resolve', () => {
  const page = read('public/index.html');
  const app = require('./app-source');
  const ids = new Set([...`${page}\n${app}`.matchAll(/\bid=["']([^"']+)/g)].map(m => m[1]));
  const used = [...app.matchAll(/(?:\$\(['"]#|getElementById\(['"])([\w-]+)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(used.filter(id => !ids.has(id)))], []);
  const symbols = new Set([...page.matchAll(/<symbol\s+id="i-([^"]+)/g)].map(m => m[1]));
  const icons = [...app.matchAll(/\bicon\(['"]([^'"]+)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(icons.filter(name => !symbols.has(name)))], []);
  const css = read('public/css/app.css');
  assert.match(css, /\.tab:not\(\.active\) span\s*\{\s*display:\s*none/);
  assert.match(css, /\.tab\.active\s*\{[^}]*flex-grow:\s*1\.5/);
  assert.doesNotMatch(css, /\.tab span\s*\{\s*display:\s*none/);
  for (const tab of ['chat', 'people', 'observatory', 'library']) {
    const tag = new RegExp(`<button class="([^"]*)"[^>]+data-tab="${tab}"`).exec(page);
    assert.ok(tag, `${tab} tab`);
    assert.doesNotMatch(tag[1], /host-only|ctl-only/, `${tab} must be visible to every admitted user`);
  }
  assert.match(page, /<section class="panel" data-panel="observatory">/);
  assert.match(page, /<section class="panel" data-panel="library">/);

  for (const [htmlFile, jsFile] of [['extension/sidebar.html', 'extension/sidebar.js'], ['extension/theater.html', 'extension/theater.js']]) {
    const html = read(htmlFile), js = read(jsFile);
    const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)/g)].map(m => m[1]));
    const jsIds = [...js.matchAll(/(?:\$\(['"]#|getElementById\(['"])([\w-]+)/g)].map(m => m[1]);
    assert.deepEqual([...new Set(jsIds.filter(id => !htmlIds.has(id)))], [], jsFile);
  }
});

test('manifest and HTML local assets exist and extension versions agree', () => {
  const manifest = JSON.parse(read('extension/manifest.json'));
  const refs = [manifest.background.service_worker, manifest.side_panel.default_path,
    ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon),
    ...manifest.content_scripts.flatMap(x => [...(x.js || []), ...(x.css || [])])];
  for (const rel of new Set(refs)) assert.ok(fs.existsSync(path.join(ROOT, 'extension', rel)), rel);
  assert.equal(/LATEST_EXT_VERSION = '([^']+)'/.exec(read('public/js/media.js'))[1], manifest.version);
  for (const html of ['public/index.html', 'extension/sidebar.html', 'extension/theater.html']) {
    const dir = path.dirname(path.join(ROOT, html));
    for (const m of read(html).matchAll(/(?:src|href)="([^"#]+)"/g)) {
      if (!/^(?:https?:|\/)/.test(m[1])) assert.ok(fs.existsSync(path.resolve(dir, m[1])), `${html}: ${m[1]}`);
    }
  }
});

test('streaming overlays keep chat interactive, show every participant, and scatter reactions', () => {
  const service = read('extension/service.js');
  const sidebar = read('extension/sidebar.js');
  const theater = read('extension/theater.js');
  const theaterPage = read('extension/theater.html');
  const theaterCss = read('extension/theater.css');
  const app = require('./app-source');
  const css = read('public/css/app.css');
  const page = read('public/index.html');

  // The injected controls use the browser top layer and mirror Netflix's own control visibility,
  // while an open chat is deliberately excluded from the idle-collapse selector.
  assert.match(service, /host\.popover = 'manual'/);
  assert.match(service, /host\.showPopover/);
  assert.match(service, /netflixControlsVisible/);
  assert.match(service, /native-controls-hidden/);
  assert.doesNotMatch(service, /\.wrap\.idle \.bar, \.wrap\.idle \.chat/);

  // Chat emoji insertion is separate from room reactions, and reactions choose both axes instead of
  // using the old fixed upper-right notification stack.
  assert.match(service, /WpEmoji.create/);
  assert.match(sidebar, /WpEmoji.create/);
  assert.match(page, /id="chatEmojiBtn"/);
  assert.match(service, /Math\.random\(\) \* 86/);
  assert.match(service, /Math\.random\(\) \* 62/);
  assert.match(service, /if \(item\.kind === 'react'\) \{ floatReaction\(item\); return; \}/);

  // Camera tiles show only participants sharing video; the service and side panels still derive
  // cameras from the people list and merge in streams when available.
  assert.match(service, /ui && ui\.people/);
  assert.match(sidebar, /ui && ui\.people/);
  assert.match(service, /selfCamera = cameras\.find\(c => c\.self\)/);
  assert.match(sidebar, /selfCamera = cameras\.find\(c => c\.self\)/);
  assert.match(service, /if \(cam\) active\.delete\(camKey\(cam\)\)/);
  assert.match(sidebar, /if \(cam\) active\.delete\(camKey\(cam\)\)/);
  assert.match(app, /const want = \[\];[\s\S]{0,160}for \(const \[id, p\] of S\.peers\) if \(p\.media && p\.media\.cam\) want\.push/);
  assert.match(app, /peopleHere\.map\(p => \(\{ id: p\.id,/);

  // Theater notifications live in the extension wrapper above the Netflix iframe. The hidden copy
  // in the party iframe cannot leave clipped fragments, and action buttons route back to the party.
  assert.match(theaterPage, /id="notices"/);
  assert.match(theaterCss, /\.notices \{[^}]*z-index: 4/);
  assert.match(app, /wpTheater: 'toast'/);
  assert.match(app, /e\.data\.wpTheater !== 'toast-action'/);
  assert.match(theater, /partyFrame\.contentWindow\.postMessage\(\{ wpTheater: 'toast-action'/);
  assert.match(css, /#app\.theater-svc \.toasts \{ display: none; \}/);

  // The party page is nested in theater mode, so its top-level extension wrapper owns Document PiP.
  // The requested viewport width follows the same --sidebar token used by the normal room panel.
  assert.match(app, /getPropertyValue\('--sidebar'\)/);
  assert.match(app, /wpTheater: 'pip'/);
  assert.match(theater, /documentPictureInPicture\.requestWindow\(\{ width, height: 520, preferInitialWindowPlacement: true \}\)/);
  assert.match(theater, /sidebar\.html\?popout=1/);
  assert.match(theater, /Math\.min\(520, Number\(requestedWidth\) \|\| 348\)/);
});

test('Netflix next episode preserves the active profile session before falling back to navigation', () => {
  const service = read('extension/service.js');
  const theater = read('extension/theater.js');
  const media = read('public/js/media.js');
  const app = require('./app-source');

  assert.match(service, /nextEpisodeIntent = \{ url: sharedPageUrl\(\), at: Date\.now\(\) \}/);
  assert.match(service, /advanceFrom: TOP && nextEpisodeIntent/);
  assert.match(service, /c\.op === 'next' && NETFLIX/);
  assert.match(media, /advance\(url\) \{ this\.cmd\(\{ op: 'next', url \}\); \}/);
  assert.match(app, /remote\.advance\(movie\.url\)/);
  assert.match(app, /transitioning: !!serviceAdvance/);
  assert.match(theater, /nativeTransition = show && !!m\.transitioning/);
  assert.match(theater, /show && !nativeTransition/);
});

test('anime HLS proxy signs links, rewrites playlists through itself, and converts subtitles', () => {
  const anime = require('../server/anime');
  anime.init('admin-secret-key');
  const referer = 'https://megaplay.buzz/stream/ani/151801/2/dub';

  // A signed link round-trips to its exact upstream URL + referer; a tampered one does not.
  const link = anime.signedPath('m3u8', 'https://cdn.example/a/master.m3u8', referer);
  assert.match(link, /^\/anime\/m3u8\/[A-Za-z0-9_-]+\/[0-9a-f]{20}\.m3u8$/);
  const parsed = anime.parseProxyPath(link);
  assert.equal(parsed.kind, 'm3u8');
  assert.equal(parsed.url, 'https://cdn.example/a/master.m3u8');
  assert.equal(parsed.referer, referer);
  assert.equal(anime.parseProxyPath(link.replace(/([0-9a-f])(\.m3u8)$/, (_, c, e) => (c === 'a' ? 'b' : 'a') + e)), null, 'a tampered signature is rejected');
  assert.equal(anime.parseProxyPath('/anime/seg/not-base64!!/0000000000000000000a.ts'), null);

  // Every URI (variant playlist, segment, key, subtitle media) is routed back through us, with the
  // room-auth query carried onto each child, and relative URIs resolved against the playlist.
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv/720.m3u8\n#EXT-X-MEDIA:TYPE=SUBTITLES,URI="subs/en.m3u8"\n';
  const rm = anime.rewriteM3u8(master, 'https://cdn.example/a/master.m3u8', referer, 'k=guestsecretkey1234&c=abc');
  assert.doesNotMatch(rm, /cdn\.example/, 'no upstream URL leaks to the client');
  for (const l of rm.split('\n').filter(x => x && x[0] !== '#' || /URI="/.test(x))) {
    if (/\/anime\//.test(l)) assert.match(l, /k=guestsecretkey1234&c=abc/, 'children carry the room auth');
  }
  const media720 = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example/a/key.bin"\nseg0.ts\n#EXT-X-MAP:URI="init.mp4"\n';
  const rmedia = anime.rewriteM3u8(media720, 'https://cdn.example/a/720.m3u8', referer, 'k=guestsecretkey1234');
  const seg = rmedia.split('\n').find(l => l && l[0] !== '#');
  assert.equal(anime.parseProxyPath(seg.split('?')[0]).url, 'https://cdn.example/a/seg0.ts');
  assert.equal(anime.parseProxyPath(/URI="([^"]+)"/.exec(rmedia.match(/EXT-X-KEY[^\n]*/)[0])[1].split('?')[0]).kind, 'seg', 'the decryption key is proxied too');

  // SubRip is converted to WebVTT; existing VTT is left alone.
  assert.match(anime.toVtt('1\n00:00:01,000 --> 00:00:02,000\nHi\n'), /^WEBVTT\n\n00:00:01\.000 --> 00:00:02\.000\nHi/);
  assert.match(anime.toVtt('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n'), /^WEBVTT/);
});

test('anime caption discovery rejects thumbnails even when the provider calls them captions', () => {
  const { parseSource } = require('../server/anime');
  const source = parseSource({ source: 'https://megavid.buzz/stream/master.m3u8', tracks: [
    { file: '/sub/token/eng-0.vtt', label: 'English', kind: 'captions' },
    { file: '/sub/token/thumbnails.vtt', kind: 'captions' },
    { file: '/sub/token/storyboard.vtt', label: 'Subtitles', type: 'captions' },
    { label: 'English' },
    null,
  ] }, 'megavid.buzz');
  assert.equal(source.subtitles.length, 1);
  assert.equal(source.subtitles[0].label, 'English');
  assert.equal(source.subtitles[0].url, 'https://megavid.buzz/sub/token/eng-0.vtt');
});

test('anime resolves source URLs for Watch Party without a third-party iframe player', () => {
  const anime = require('../server/anime');
  assert.deepEqual(anime.embedSources(151801, 52211, 1, 'dub'), [
    'https://megaplay.buzz/stream/ani/151801/1/dub',
    'https://megaplay.buzz/stream/mal/52211/1/dub',
  ]);
  assert.doesNotMatch(read('public/js/media.js'), /class MegaplayMedia/);
  assert.doesNotMatch(read('public/index.html'), /id="mpHost"|id="animeSocial"/);
  assert.match(require('./app-source'), /kindOf\(movie\) === 'anime'/);
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
  const files = walk(path.join(ROOT, 'extension')).filter(file => path.relative(path.join(ROOT, 'extension'), file) !== 'LICENSE');
  assert.equal(zip.size, files.length + 1);
  assert.equal(zip.get('watch-party-sync/LICENSE').toString(), read('LICENSE'));
  for (const file of files) {
    const rel = path.relative(path.join(ROOT, 'extension'), file).replaceAll('\\', '/');
    const packed = zip.get(`watch-party-sync/${rel}`);
    assert.ok(packed, `${rel} missing from extension ZIP`);
    assert.deepEqual(packed, fs.readFileSync(file), rel);
  }
});

test('extension archives are byte-reproducible', () => {
  const { archiveDirectory } = require('../build/build-extensions');
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

test('store upload has a root manifest, exact extension files and reproducible bytes', () => {
  const { buildStore } = require('../build/build-extensions');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-store-'));
  try {
    fs.mkdirSync(path.join(root, 'extension'));
    fs.mkdirSync(path.join(root, 'public', 'js'), { recursive: true });
    fs.writeFileSync(path.join(root, 'extension', 'manifest.json'), JSON.stringify({ version: '1.0.0', description: 'Watch together.' }));
    fs.writeFileSync(path.join(root, 'extension', 'background.js'), '// packaged code\n');
    fs.writeFileSync(path.join(root, 'public', 'js', 'media.js'), "const LATEST_EXT_VERSION = '1.0.0';");
    const output = buildStore(root), first = fs.readFileSync(output), entries = unzipEntries(output);
    assert.deepEqual([...entries.keys()].sort(), ['background.js', 'manifest.json']);
    for (const [name, bytes] of entries) assert.deepEqual(bytes, fs.readFileSync(path.join(root, 'extension', name)));
    fs.utimesSync(path.join(root, 'extension', 'manifest.json'), new Date(), new Date());
    buildStore(root);
    assert.deepEqual(fs.readFileSync(output), first);
    fs.writeFileSync(path.join(root, 'extension', 'manifest.json'), JSON.stringify({ version: '1.0.0', description: 'x'.repeat(133) }));
    assert.throws(() => buildStore(root), /description/);
    fs.writeFileSync(path.join(root, 'extension', 'manifest.json'), JSON.stringify({ version: '2.0.0', description: 'Watch together.' }));
    assert.throws(() => buildStore(root), /version mismatch/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('iPad browser playback detection survives extension removal', async () => {
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(read('public/js/platform.js')).toString('base64')}`;
  const { detectPlatform } = await import(moduleUrl);
  const ipad = detectPlatform({ userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1', platform: 'MacIntel', maxTouchPoints: 5 });
  assert.equal(ipad.ipad, true); assert.equal(ipad.appleMobile, true); assert.equal(ipad.safari, true);
  const iphone = detectPlatform({ userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 CriOS/130.0 Mobile Safari/604.1' });
  assert.equal(iphone.iphone, true); assert.equal(iphone.safari, false);
  assert.match(read('public/js/player.js'), /PLATFORM.appleMobile \|\| PLATFORM.safari/);
  assert.match(read('public/js/fullscreen.js'), /webkitFullscreenElement/);
  assert.doesNotMatch(require('./app-source'), /safariExtension|TestFlight|safariRuntime/);
  assert.doesNotMatch(read('public/index.html'), /safariExtension|TestFlight/);
  assert.ok(!fs.existsSync(path.join(ROOT, 'apple')));
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
  assert.match(read('docs/GUIDE.md'), /\.github\/badges\/sync\.svg/);
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
  const app = require('./app-source'), room = read('server/room.js');
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
  assert.match(sw, /['"]\/vendor\/hls\.min\.js['"]/);
  assert.match(sw, /['"]\/js\/file-playback\.js['"]/);
  assert.match(read('server/index.js'), /manifest\.webmanifest[\s\S]*private, no-store/);
  assert.match(read('server/index.js'), /worker-src 'self' blob:/);
  assert.doesNotMatch(read('public/favicon.svg'), /<metadata|xmlns:[\w-]+=/i);
});

test('playback capabilities select native or MSE HLS and allow a growing HLS-only movie', async () => {
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(read('public/js/capabilities.js')).toString('base64')}`;
  const { playbackCapabilities, deliverySources, reconcileDeliverySources } = await import(moduleUrl);
  const safari = playbackCapabilities({ canPlayType: type => type.includes('mpegurl') ? 'maybe' : '' }, {});
  assert.deepEqual(safari, { hls: true, mse: false, nativeHlsPreferred: false });
  const chromeVideo = { canPlayType: type => type.includes('mpegurl') ? 'maybe' : '' };
  const chrome = playbackCapabilities(chromeVideo, { MediaSource: class {} }, { safari: false, appleMobile: false });
  assert.deepEqual(deliverySources({ hls: '/media/abc/hls/index.m3u8', progressive: true }, chrome, 'key'), [
    { type: 'hls-js', url: '/media/abc/hls/index.m3u8?k=key' },
  ], 'Chrome reports native HLS, but its player cannot follow a growing playlist');
  const appleSafari = playbackCapabilities(chromeVideo, { ManagedMediaSource: class {} }, { safari: true, appleMobile: true });
  assert.deepEqual(deliverySources({ hls: '/media/abc/hls/index.m3u8', progressive: true }, appleSafari, 'key'), [
    { type: 'native-hls', url: '/media/abc/hls/index.m3u8?k=key' },
    { type: 'hls-js', url: '/media/abc/hls/index.m3u8?k=key' },
  ], 'Safari keeps its own HLS player first, with hls.js as the fallback');
  const movie = { url: '/media/abc/video', hls: '/media/abc/hls/index.m3u8' };
  assert.deepEqual(deliverySources(movie, safari, 'room key', 'viewer'), [
    { type: 'direct', url: '/media/abc/video?k=room+key&c=viewer' },
    { type: 'native-hls', url: '/media/abc/hls/index.m3u8?k=room+key&c=viewer' },
  ]);
  assert.deepEqual(deliverySources(movie, { hls: false, mse: false }, 'key', 'viewer'), [{ type: 'direct', url: '/media/abc/video?k=key&c=viewer' }]);
  assert.deepEqual(deliverySources({ hls: movie.hls, progressive: true }, { hls: false, mse: true }, 'key', 'viewer'), [
    { type: 'hls-js', url: '/media/abc/hls/index.m3u8?k=key&c=viewer' },
  ]);
  assert.deepEqual(deliverySources({ hls: movie.hls }, { hls: true, mse: false }, 'key'), [
    { type: 'native-hls', url: '/media/abc/hls/index.m3u8?k=key' },
  ]);
  const direct = { type: 'direct', url: '/media/abc/video?k=key' };
  const hls = { type: 'native-hls', url: '/media/abc/hls/index.m3u8?k=key' };
  assert.deepEqual(reconcileDeliverySources([hls, direct], direct, false), {
    sources: [direct, hls], activate: null,
  }, 'a working direct source stays attached when progressive HLS appears');
  assert.deepEqual(reconcileDeliverySources([direct, hls], hls, false), {
    sources: [hls, direct], activate: null,
  }, 'a working HLS source stays attached when the final direct copy appears');
  assert.deepEqual(reconcileDeliverySources([hls, direct], direct, true), {
    sources: [hls, direct], activate: hls,
  }, 'a failed source switches to the newly available alternative');
  assert.deepEqual(reconcileDeliverySources([direct], hls, false), {
    sources: [direct], activate: direct,
  }, 'a removed active source switches to the remaining format');
  assert.deepEqual(reconcileDeliverySources([hls], hls, true), {
    sources: [hls], activate: hls,
  }, 'a failed sole source can be retried after its metadata changes');
  const app = require('./app-source');
  assert.match(app, /function nativeHlsViewerHere\(\).*status\?\.hls/);
  assert.match(app, /case 'quickprep':[\s\S]{0,80}const opts = \{ hls: true \}/);
  assert.match(app, /case 'prepare':[\s\S]{0,80}const o = \{ hls: true,/);
  assert.match(app, /setTimeout\([\s\S]{0,160}video\.readyState < 2[\s\S]{0,80}20000/);
  assert.match(app, /Start sooner for everyone/);
  assert.match(app, /Ready to watch · still preparing in background/);
  assert.match(app, /if \(same\)[\s\S]{0,220}refreshFileSources\(movie\)/);
  // The hls.js fallback on iPhone/iPad can attach via a <source> child, leaving video.src empty.
  // The sync loop must use currentSrc so it still seeks and plays there.
  const player = read('public/js/player.js');
  assert.match(player, /!v\.currentSrc \|\| v\.readyState < 1\) return/);
  assert.doesNotMatch(player, /\|\| !v\.src \|\|/);
});

test('file playback owns HLS attachment, recovery, fallback, and stale loads', async () => {
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(read('public/js/file-playback.js')).toString('base64')}`;
  const { FilePlayback } = await import(moduleUrl);
  const instances = [];
  class FakeHls {
    static Events = { MEDIA_ATTACHED: 'attached', MANIFEST_PARSED: 'manifest', FRAG_BUFFERED: 'fragment', ERROR: 'error' };
    static ErrorTypes = { NETWORK_ERROR: 'network', MEDIA_ERROR: 'media' };
    static isSupported() { return true; }
    constructor(options) { this.options = options; this.events = new Map(); instances.push(this); }
    on(name, callback) { this.events.set(name, callback); }
    emit(name, data) { this.events.get(name)?.(name, data); }
    attachMedia(video) { this.video = video; this.emit(FakeHls.Events.MEDIA_ATTACHED); }
    loadSource(url) { this.url = url; this.sourceLoads = (this.sourceLoads || 0) + 1; }
    startLoad(at) { this.startedAt = at; this.starts = (this.starts || 0) + 1; }
    recoverMediaError() { this.recoveries = (this.recoveries || 0) + 1; }
    destroy() { this.destroyed = true; }
  }
  const video = {
    currentTime: 12, src: '', pause() {}, removeAttribute(name) { if (name === 'src') this.src = ''; },
    load() { this.loads = (this.loads || 0) + 1; },
  };
  let ready = 0, fatal = 0;
  const playback = new FilePlayback(video, { loader: async () => FakeHls, onReady: () => ready++, onFatal: () => fatal++ });
  await playback.open({ type: 'hls-js', url: '/movie.m3u8' }, 33);
  const first = instances[0];
  assert.equal(first.url, '/movie.m3u8');
  first.emit(FakeHls.Events.ERROR, { fatal: true, type: FakeHls.ErrorTypes.NETWORK_ERROR, details: 'manifestLoadTimeOut' });
  assert.equal(first.sourceLoads, 2, 'startup recovery must request the missing manifest again');
  assert.equal(first.starts, undefined, 'starting segments cannot recover a missing manifest');
  first.emit(FakeHls.Events.MANIFEST_PARSED);
  assert.equal(first.startedAt, 33);
  first.emit(FakeHls.Events.FRAG_BUFFERED); first.emit(FakeHls.Events.FRAG_BUFFERED);
  assert.equal(ready, 1);
  first.emit(FakeHls.Events.ERROR, { fatal: true, type: FakeHls.ErrorTypes.MEDIA_ERROR });
  assert.equal(first.recoveries, 1); assert.equal(fatal, 0);
  first.emit(FakeHls.Events.ERROR, { fatal: true, type: FakeHls.ErrorTypes.MEDIA_ERROR, details: 'decode failed' });
  assert.equal(first.destroyed, true); assert.equal(fatal, 1);

  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const stale = new FilePlayback(video, { loader: () => delayed });
  const opening = stale.open({ type: 'hls-js', url: '/old.m3u8' });
  await stale.open({ type: 'direct', url: '/new.mp4' });
  release(FakeHls); await opening;
  assert.equal(video.src, '/new.mp4');
  assert.equal(instances.length, 1, 'stale async HLS load must not attach');
  stale.close();
  assert.equal(video.src, '');

  let resumePosition = 0;
  await playback.open({ type: 'hls-js', url: '/anime/m3u8/source/signature.m3u8?k=key' }, () => resumePosition);
  resumePosition = 449;
  instances.at(-1).emit(FakeHls.Events.MANIFEST_PARSED);
  assert.equal(instances.at(-1).startedAt, 449, 'episode state arriving after open must determine the first downloaded segment');
  await playback.open({ type: 'hls-js', url: '/anime/m3u8/retry/signature.m3u8?k=key' });
  const retry = instances.at(-1);
  for (let i = 0; i < 3; i++) retry.emit(FakeHls.Events.ERROR, { fatal: true, type: FakeHls.ErrorTypes.NETWORK_ERROR, details: 'manifestLoadTimeOut' });
  assert.equal(retry.sourceLoads, 3, 'manifest retries are bounded');
  assert.equal(fatal, 2, 'persistent source failures must surface instead of leaving an endless spinner');
});

test('room keys, permissions, URL selection, public data, and timeline commands work', async t => {
  const { Room, randKey, PERMS, REACTIONS } = require('../server/room');
  assert.match(randKey(24), /^[A-Za-z0-9]{24}$/); assert.equal(new Set(PERMS).size, 4); assert.ok(REACTIONS.includes('👏'));
  const library = { playable: id => id === 'movie'
    ? { id, title: 'Movie', file: 'D:\\private\\movie.mp4', duration: 100, subs: [] }
    : id === 'live' ? { id, title: 'Live', file: null, duration: 100, hls: true, progressive: true, subs: [] } : null,
  list: () => ({ folders: ['D:\\private'], scanning: false, items: [{ id: 'movie', rel: 'secret\\movie.mp4' }] }) };
  const room = new Room({ config: { adminKey: 'admin-secret-key', roomKey: 'guestsecretkey1234', safariExtensionUrl: 'https://testflight.apple.com/join/AbCd1234', room: {} }, library, save() {}, animeSearch: async q => [{ id: 151801, title: q }],
    // ep 2 resolves to native HLS; other episodes exercise source resolution failure.
    animeResolve: async (anilistId, malId, ep) => ep === 2 ? { url: 'https://cdn.example/stream/master.m3u8', referer: 'https://megaplay.buzz/stream/ani/151801/2/dub', subtitles: [{ url: 'https://cdn.example/subs/en.vtt', label: 'English', lang: 'en', kind: 'captions' }], intro: { start: 0, end: 90 }, outro: null } : null });
  t.after(() => room.shutdown());
  assert.equal(room.roleForKey('admin-secret-key', true), 'host');
  assert.equal(room.roleForKey('admin-secret-key', false), null);
  assert.equal(room.roleForKey('guestsecretkey1234'), 'guest');
  const host = { id: 'host01', name: 'Host', role: 'host', admitted: true, perms: Object.fromEntries(PERMS.map(p => [p, true])), ws: { readyState: 0 } };
  const guestMessages = [];
  const guest = { id: 'guest01', name: 'Alex', role: 'guest', admitted: true, perms: { playback: false, chat: true, react: true, camera: true }, ws: { readyState: 1, send: raw => guestMessages.push(JSON.parse(raw)) } };
  room.selectMovie(host, 'movie');
  assert.equal(room.publicMovie().file, undefined); assert.equal(room.publicMovie().url, '/media/movie/video');
  room.selectMovie(host, 'live');
  assert.equal(room.publicMovie().url, null);
  assert.equal(room.publicMovie().hls, '/media/live/hls/index.m3u8');
  assert.equal(room.publicMovie().progressive, true);
  room.selectMovie(host, 'movie');
  room.command(host, { action: 'seek', position: 500 }); assert.equal(room.state.position, 100);
  room.selectUrl(host, 'http://127.0.0.1/private', false, { custom: true }); assert.equal(room.movie.kind, 'file');
  room.selectUrl(host, 'https://example.com/watch?ep=2', false, { custom: true, strict: true });
  assert.equal(room.movie.service, 'custom'); assert.equal(room.movie.strict, true);
  room.selectUrl(host, 'https://www.netflix.com/watch/111?trackId=7', false);
  assert.equal(room.movie.advanceFrom, null);
  room.selectUrl(host, 'https://www.netflix.com/watch/222?trackId=8', false, { follow: true, advanceFrom: 'https://www.netflix.com/watch/111?from=player', position: 2, playing: true });
  assert.equal(room.publicMovie().advanceFrom, 'https://www.netflix.com/watch/111');
  room.selectUrl(host, 'https://www.netflix.com/watch/333', false, { follow: true, advanceFrom: 'https://www.netflix.com/watch/999' });
  assert.equal(room.publicMovie().advanceFrom, null, 'an unrelated page cannot request a native next-episode transition');
  room.selectMovie(guest, 'movie');
  assert.equal(room.movie.id, 'movie', 'content selection is independent of transport permission');
  room.selectUrl(guest, 'https://www.netflix.com/watch/444', false);
  assert.equal(room.movie.url, 'https://www.netflix.com/watch/444');
  await room.selectAnime(guest, { anilistId: 151801, malId: 52211, ep: 2, lang: 'dub', title: 'Mashle' });
  assert.equal(room.movie.kind, 'anime', 'a resolved stream plays natively in the shared <video>, not an iframe');
  const am = room.publicMovie();
  assert.match(am.hls, /^\/anime\/m3u8\//, 'native anime is delivered as proxied HLS');
  assert.equal(am.url, null, 'native anime has no direct MP4 url, so delivery uses HLS');
  assert.equal(am.subs.length, 1); assert.match(am.subs[0].url, /^\/anime\/sub\//);
  assert.deepEqual({ anilistId: am.anilistId, episode: am.episode, language: am.language }, { anilistId: 151801, episode: 2, language: 'dub' });
  await room.selectAnime(guest, { ...am, ep: room.movie.episode + 1, lang: room.movie.language, title: room.movie.animeTitle });
  assert.equal(room.movie.episode, 2, 'failed resolution preserves the current episode');
  assert.equal(room.movie.kind, 'anime', 'source failure must never replace Watch Party controls with an embed');
  assert.equal(guestMessages.at(-1).selection, 'anime');
  assert.equal(guestMessages.at(-1).kind, 'error');
  const beforeCustom = room.movie.id;
  room.selectUrl(guest, 'https://example.com/watch', false, { custom: true });
  assert.equal(room.movie.id, beforeCustom, 'arbitrary custom sites remain host-only');
  room.onMessage(guest, { type: 'lib-list' });
  assert.equal(guestMessages.at(-1).library.items[0].rel, 'movie.mp4');
  room.onMessage(guest, { type: 'anime-search', q: 'Mashle' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(guestMessages.at(-1).type, 'anime-results'); assert.equal(guestMessages.at(-1).results[0].title, 'Mashle');
  assert.equal(room.guestLibrary().folders[0], '(the host\'s movies)'); assert.equal(room.guestLibrary().items[0].rel, 'movie.mp4');
  assert.equal(room.publicSettings(false).safariExtensionUrl, undefined);
  const app = require('./app-source');
  assert.doesNotMatch(app, /if \(!isHost && !canControl\(\)\) return noPerm\('playback'\);\s*\n\s*\$\('#ytChips'\)/);
  assert.match(app, /if \(!isHost\) \{ conn\.send\(\{ type: 'lib-list' \}\); return; \}/);
  assert.doesNotMatch(app, /function renderObservatory\(\) \{\s*if \(!isHost\) return/);
});

test('Sync Observatory keeps bounded in-memory health, corrections, and recommendations', t => {
  const { Room } = require('../server/room');
  const config = { adminKey: 'admin-secret-key', roomKey: 'guestsecretkey1234', room: { autoWait: false } };
  const room = new Room({ config, library: { list: () => ({ folders: [], scanning: false, items: [] }) }, save() {} });
  t.after(() => room.shutdown());
  room.movie = { id: 'movie', kind: 'file', title: 'Movie', duration: 3600, height: 1080, mbps: 12 };
  room.state = { movieId: 'movie', playing: false, position: 120, anchor: Date.now(), seq: 1, waiting: false, waitingFor: [] };
  const guest = { id: 'alex01', name: 'Alex', role: 'guest', admitted: true, perms: {}, capabilities: { hls: true, nativeHls: true }, ws: { readyState: 0 }, status: { at: 0 }, bufferingSince: null, lastWaitCause: 0, metrics: { corrections: [], lastCorrection: '' }, mbps: 6, bytes: 0, lastBytes: 0 };
  room.clients.set(guest.id, guest);
  room.onMessage(guest, { type: 'status', status: { loaded: true, ready: false, buffering: true, health: 8, rtt: 240, drift: -420, stalls: 3, rate: 1, correction: { id: 1, type: 'seek', drift: -420, at: Date.now(), value: 120 } } });
  room.onMessage(guest, { type: 'status', status: { loaded: true, ready: true, buffering: false, health: 45, rtt: 180, drift: -35, stalls: 3, rate: 1.02, correction: { id: 2, type: 'rate', drift: -35, at: Date.now(), value: 1.02 } } });
  const obs = room.observatory();
  assert.ok(obs.confidence >= 0 && obs.confidence <= 100);
  assert.deepEqual(obs.timeline.map(e => e.type), ['stall', 'recover']);
  assert.match(obs.recommendations[0].text, /720p.*Alex.*buffering/);
  const observedGuest = obs.participants.find(p => p.id === guest.id);
  assert.equal(observedGuest.status.corrections.length, 2);
  assert.equal(observedGuest.status.drift, -35);
  const hostView = room.people(true).find(p => p.id === guest.id).status;
  assert.equal(hostView.drift, undefined);
  assert.equal(hostView.hls, true);
  assert.equal(room.people(false).find(p => p.id === guest.id).status.hls, undefined);
  const app = require('./app-source');
  assert.match(app, /conn\.on\('observatory'.*renderPeopleDrift\(\)/);
  assert.match(app, /data-drift="\$\{esc\(p\.id\)\}"/);
  const notices = [];
  room.broadcastHosts = message => notices.push(message);
  room.onMessage(guest, { type: 'status', status: { error: 4, dev: 'iPad' } });
  room.onMessage(guest, { type: 'status', status: { error: 4, dev: 'iPad' } });
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /Start sooner for everyone/);
  assert.equal(config.syncEvents, undefined); assert.equal(config.metrics, undefined);
});

test('Sync Observatory updates do not rebroadcast the people list', t => {
  const { Room } = require('../server/room');
  const room = new Room({ config: { adminKey: 'admin-secret-key', roomKey: 'guestsecretkey1234', room: {} }, library: { list: () => ({ folders: [], scanning: false, items: [] }) }, save() {} });
  t.after(() => room.shutdown());
  const sent = { host: [], guest: [] };
  const client = (id, role) => ({
    id, name: role === 'host' ? 'Host' : 'Alex', role, admitted: true, perms: {}, media: { cam: false, mic: false },
    ws: { readyState: 1, send: raw => sent[role].push(JSON.parse(raw)) }, status: { at: Date.now(), loaded: true, ready: true, buffering: false, ahead: 10, drift: 5, health: 90, rtt: 40, rate: 1, stalls: 0 },
    metrics: { corrections: [], lastCorrection: '' }, mbps: 5, waits: [],
  });
  const host = client('host01', 'host'), guest = client('guest01', 'guest');
  room.clients.set(host.id, host); room.clients.set(guest.id, guest);
  room.movie = { id: 'movie', kind: 'file', duration: 100, height: 1080, mbps: 8 };
  room.broadcastPeople(true);
  sent.host.length = 0; sent.guest.length = 0;
  guest.status = { ...guest.status, drift: 250, health: 55, rtt: 220, rate: 1.04 };
  room.broadcastPeople(false);
  assert.deepEqual(sent.guest.map(message => message.type), ['observatory']);
  assert.deepEqual(sent.host.map(message => message.type), ['observatory']);
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

test('Movies & TV catalog searches TMDB and picks the best configured language source', async () => {
  const remoteMedia = require('../server/remote-media');
  remoteMedia.init('catalog-test-secret');
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url: String(url), options });
    return { ok: true, status: 200, json: async () => ({ results: [
      { media_type: 'movie', id: 603, title: 'The Matrix', release_date: '1999-03-30', overview: 'Neo wakes up.', vote_average: 8.2, poster_path: '/matrix.jpg' },
      { media_type: 'person', id: 1, name: 'Ignore Me' },
      { media_type: 'tv', id: 1396, name: 'Breaking Bad', first_air_date: '2008-01-20', overview: 'Chemistry.', vote_average: 8.9, poster_path: '/bb.jpg' },
    ] }) };
  };
  const config = { tmdbToken: 'tmdb-test-token', movieTvSources: [
    { type: 'movie', tmdbId: 603, language: 'en', languageLabel: 'English', quality: 1080, url: 'https://media.example/matrix-1080.m3u8' },
    { type: 'movie', tmdbId: 603, language: 'en', languageLabel: 'English', quality: 2160, url: 'https://media.example/matrix-4k.m3u8', subtitles: [{ label: 'English CC', lang: 'en', url: 'https://media.example/matrix.vtt' }] },
    { type: 'movie', tmdbId: 603, language: 'fr', languageLabel: 'Français', quality: 1080, url: 'https://media.example/matrix-fr.mp4' },
    { type: 'tv', tmdbId: 1396, season: 1, episode: 1, language: 'en', languageLabel: 'English', quality: 1080, url: 'https://media.example/bb-s1e1.m3u8' },
  ] };
  const { Catalog } = require('../server/catalog');
  const catalog = new Catalog({ config, remoteMedia, fetchFn });
  const results = await catalog.search('matrix');
  assert.deepEqual(results.map(item => item.type), ['movie', 'tv']);
  assert.equal(results[0].languages.length, 2);
  assert.equal(results[1].hasSources, true);
  assert.match(calls[0].url, /\/search\/multi\?.*query=matrix/);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer tmdb-test-token');
  const playback = catalog.resolve({ type: 'movie', tmdbId: 603 }, 'en');
  assert.equal(playback.quality, 2160);
  assert.match(playback.hlsPath, /^\/catalog-media\/m3u8\/[0-9a-f]{32}\.m3u8$/);
  assert.ok(!playback.hlsPath.includes('media.example'));
  assert.equal(playback.subtitles.length, 1);
  const target = remoteMedia.parsePath(playback.hlsPath);
  assert.equal(target.url, 'https://media.example/matrix-4k.m3u8');
  assert.equal(target.scope, playback.sourceId);
  assert.throws(() => catalog.resolve({ type: 'movie', tmdbId: 603 }, 'de'), /language is not available/i);

  await assert.rejects(remoteMedia.fetchUpstream({ url: 'http://127.0.0.1/private', headers: {} }), /blocked host/);
});

test('Movies & TV finds only explicitly licensed free media and selects its best browser file', async () => {
  const remoteMedia = require('../server/remote-media');
  const { FreeMedia, licenseInfo } = require('../server/free-media');
  const { Catalog } = require('../server/catalog');
  remoteMedia.init('free-catalog-test-secret');
  const calls = [];
  const fetchFn = async url => {
    calls.push(String(url));
    if (String(url).includes('advancedsearch.php')) return { ok: true, status: 200, json: async () => ({ response: { docs: [
      { identifier: 'licensed-film-test', title: 'Licensed Film', collection: ['feature_films'] },
    ] } }) };
    return { ok: true, status: 200, json: async () => ({
      metadata: { mediatype: 'movies', title: 'Licensed Film', date: '1941', creator: 'Example Studio', language: 'English', collection: ['feature_films'], licenseurl: 'https://creativecommons.org/publicdomain/mark/1.0/' },
      files: [
        { name: 'licensed-film-480.mp4', height: '480', size: '2000', length: '01:02:03', format: 'h.264' },
        { name: 'licensed-film-1080.mp4', height: '1080', size: '8000', length: '01:02:03', format: 'h.264' },
        { name: 'licensed-film.en.srt', size: '5000', format: 'SubRip' },
      ],
    }) };
  };
  const freeMedia = new FreeMedia({ fetchFn, secret: 'test-secret' });
  const catalog = new Catalog({ config: { freeMedia: true, adminKey: 'test-secret' }, remoteMedia, fetchFn, freeMedia });
  const results = await catalog.search('Licensed Film');
  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'free');
  assert.equal(results[0].attribution.licenseLabel, 'Public Domain');
  assert.equal(results[0].languages[0].bestQuality, 1080);
  const playback = catalog.resolve({ type: 'free', freeId: results[0].freeId }, 'en');
  assert.equal(playback.quality, 1080);
  assert.equal(playback.subtitles.length, 1);
  assert.equal(remoteMedia.parsePath(playback.urlPath).url, 'https://archive.org/download/licensed-film-test/licensed-film-1080.mp4');
  assert.ok(calls[0].includes('collection%3Aprelinger') || calls[0].includes('collection%3Afeature_films'));
  assert.equal(licenseInfo('https://creativecommons.org/licenses/by-nc/4.0/'), null, 'licenses with extra restrictions are not included');
});

test('Movies & TV selections use native playback, preserve position across languages, and expose no upstream URL', t => {
  const { Room, PERMS } = require('../server/room');
  let language = 'en';
  const catalog = {
    configured: () => true,
    resolve(ref, requested) {
      language = requested;
      return { ref, language: requested, languageLabel: requested === 'fr' ? 'Français' : 'English', languages: [{ code: 'en', label: 'English' }, { code: 'fr', label: 'Français' }], quality: 2160,
        duration: 3600, hlsPath: `/catalog-media/m3u8/${(requested === 'fr' ? 'b' : 'a').repeat(32)}.m3u8`, urlPath: null, subtitles: [], hasNext: ref.type === 'tv' && ref.episode === 1, sourceId: requested };
    },
  };
  const room = new Room({ config: { adminKey: 'admin-secret-key', roomKey: 'guestsecretkey1234', room: {} }, library: { list: () => ({ folders: [], items: [] }) }, save() {}, catalog });
  t.after(() => room.shutdown());
  const host = { id: 'host01', name: 'Host', role: 'host', admitted: true, perms: Object.fromEntries(PERMS.map(p => [p, true])), ws: { readyState: 0 } };
  const ref = { type: 'tv', tmdbId: 1396, season: 1, episode: 1 };
  room.selectCatalog(host, { ref, language: 'en', title: 'Breaking Bad' });
  let movie = room.publicMovie();
  assert.equal(movie.kind, 'catalog');
  assert.equal(movie.quality, 2160);
  assert.equal(movie.url, null);
  assert.match(movie.hls, /^\/catalog-media\/m3u8\//);
  assert.equal(movie.hasNext, true);
  room.state = { ...room.state, playing: true, position: 42, anchor: Date.now() };
  room.selectCatalog(host, { ref, language: 'fr', title: 'Breaking Bad' });
  movie = room.publicMovie();
  assert.equal(language, 'fr');
  assert.equal(movie.languageLabel, 'Français');
  assert.ok(room.state.position >= 42 && room.state.position < 43, 'language switching preserves the shared timestamp');
  assert.equal(room.publicSettings(false).movieTvConfigured, true);
});

test('tool, UPnP, tunnel, and TURN helpers retain expected behavior', async t => {
  const tools = require('../server/tools');
  assert.equal(tools.encoderLabel('hevc_nvenc'), 'NVIDIA GPU'); assert.equal(tools.encoderLabel(null), 'none');
  assert.deepEqual(await tools.detectEncoders(null), { hevc: null, h264: null, aac: null, hevcSoftware: false, h264Software: false, list: [] });
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
  assert.equal(migrated.safariExtensionUrl, undefined);
  assert.equal(migrated.version, 2);
  assert.equal(migrateConfig({ version: 2, tunnel: 'cloudflare' }).tunnel, 'cloudflare');
  assert.doesNotMatch(read('docs/FFMPEG.md'), /installed by refresh\.bat/i);
});

function event() { const listeners = []; return { addListener(fn) { listeners.push(fn); }, fire(...a) { return listeners.map(fn => fn(...a)); } }; }

test('custom-site extension installs scoped ad rules and preserves same-site popup buttons', async () => {
  const updates = [], removed = [], activated = [], timers = [];
  const runtimeMessage = event();
  const context = vm.createContext({ URL, URLSearchParams, console, self: {}, importScripts() {}, setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {}, chrome: {
    runtime: { id: 'ext', onConnect: event(), onMessage: runtimeMessage, getURL: p => `chrome-extension://ext/${p}` },
    sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
    tabs: { onRemoved: event(), onCreated: event(), query: async () => [], get: async () => ({ url: 'chrome-extension://ext/theater.html' }), update: async (id, x) => { activated.push([id, x]); }, remove: async id => { removed.push(id); }, sendMessage: async () => {}, create: async () => ({ id: 2 }) },
    webNavigation: { onCreatedNavigationTarget: event(), onDOMContentLoaded: event(), getAllFrames: async () => [] }, scripting: { executeScript: async () => {} }, windows: { get: async () => ({}), update: async () => {} },
    declarativeNetRequest: { getSessionRules: async () => [], updateSessionRules: async x => { updates.push(x); } },
  } });
  context.importScripts = (...files) => { for (const file of files) vm.runInContext(read('extension/' + file), context); };
  vm.runInContext(read('extension/background.js'), context);
  assert.ok(context.self.WP_AD_DOMAINS.length >= 80);
  let reply;
  runtimeMessage.fire({ wp: 'theater-hello', party: 'https://party.example/join/key', custom: 'https://video.example/watch', blockPopups: true }, { id: 'ext', url: 'chrome-extension://ext/theater.html', frameId: 0, tab: { id: 7 } }, x => { reply = x; });
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

test('secret, authentication, and cleanup invariants remain enforced', () => {
  const ignored = read('.gitignore');
  for (const pattern of ['.env', 'credentials*.json', 'secrets*.json', '*.key', '*.pem', '*.p12', '*.pfx', '*.p8', '*.mobileprovision']) {
    assert.ok(ignored.split(/\r?\n/).includes(pattern), `${pattern} must stay ignored`);
  }

  const production = ['server', 'public', 'extension', 'build', '.github'].flatMap(dir => walk(path.join(ROOT, dir)))
    .filter(file => !file.includes(path.join('build', 'cache')) && !file.includes(path.sep + 'Tests' + path.sep) && !/\.(?:zip|png|ico|exe|dll)$/i.test(file));
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
  assert.match(index, /if \(!pl\?\.file\) return missing\(\)/);
  assert.doesNotMatch(index, /-Message \$\{JSON\.stringify/);
  assert.ok(!fs.existsSync(path.join(ROOT, 'extension/popup.html')));
  assert.ok(!fs.existsSync(path.join(ROOT, 'extension/popup.js')));
  assert.doesNotMatch(`${read('public/css/app.css')}\n${read('README.md')}\n${read('docs/FFMPEG.md')}`, /tunnel-box|link-seg|tile\.speaking|Start Watch Party\.bat/);
});
