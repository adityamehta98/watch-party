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

test('streaming overlays keep chat interactive, show every participant, and scatter reactions', () => {
  const service = read('extension/service.js');
  const sidebar = read('extension/sidebar.js');
  const theater = read('extension/theater.js');
  const theaterPage = read('extension/theater.html');
  const theaterCss = read('extension/theater.css');
  const app = read('public/js/app.js');
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
  assert.match(service, /data-chat-emoji/);
  assert.match(sidebar, /data-chat-emoji/);
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
  const app = read('public/js/app.js');

  assert.match(service, /nextEpisodeIntent = \{ url: location\.href, at: Date\.now\(\) \}/);
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

test('MegaPlay uses one native transport layer and shares native actions with the room', () => {
  const anime = require('../server/anime');
  assert.deepEqual(anime.embedSources(151801, 52211, 1, 'dub'), [
    'https://megaplay.buzz/stream/ani/151801/1/dub',
    'https://megaplay.buzz/stream/mal/52211/1/dub',
  ]);
  assert.ok(anime.embedSources(151801, 52211, 1, 'dub').every(url => url.endsWith('/dub')));

  const appended = [];
  const window = { addEventListener() {}, postMessage() {} };
  const document = { createElement: () => ({ contentWindow: { postMessage() {} }, style: {} }) };
  const context = vm.createContext({ URL, Event, EventTarget, performance, window, document,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1 });
  vm.runInContext(`${read('public/js/media.js').replace(/^export /gm, '')}\nglobalThis.TestMegaplayMedia = MegaplayMedia;`, context);
  const host = { innerHTML: '', appendChild(node) { appended.push(node); } };
  const actions = [];
  const player = new context.TestMegaplayMedia(host, { onUser: action => actions.push(action) });
  player.open({ url: 'https://megaplay.buzz/stream/ani/151801/1/dub' });
  const frame = appended[0];
  assert.equal(frame.src, 'https://megaplay.buzz/stream/ani/151801/1/dub');
  assert.equal(frame.referrerPolicy, 'origin');
  assert.equal(frame.frameBorder, '0');
  assert.equal(frame.scrolling, 'no');
  assert.equal(frame.allowFullscreen, true);
  assert.match(frame.allow, /fullscreen/);
  player.onMessage({ source: frame.contentWindow, origin: 'https://megaplay.buzz', data: { event: 'time', time: 12, duration: 1420 } });
  assert.equal(player.ready, true);
  assert.equal(player.currentTime, 12);
  assert.equal(player.duration, 1420);
  player.onMessage({ source: frame.contentWindow, origin: 'https://megaplay.buzz', data: { type: 'watching-log', currentTime: 18, duration: 1420 } });
  assert.equal(player.currentTime, 18);
  player.prevAt = performance.now() - 1000; player.prevT = 18; player._playing = false;
  player.onMessage({ source: frame.contentWindow, origin: 'https://megaplay.buzz', data: { event: 'time', time: 19, duration: 1420 } });
  assert.equal(actions.at(-1).action, 'play');
  assert.ok(player.holdUntil > performance.now(), 'native play is held before the sync correction loop');
  player.prevAt = performance.now() - 500; player.prevT = 19; player._playing = true;
  player.onMessage({ source: frame.contentWindow, origin: 'https://megaplay.buzz', data: { event: 'time', time: 40, duration: 1420 } });
  assert.deepEqual({ ...actions.at(-1) }, { action: 'seek', t: 40 });
  // A stall is never guessed as a pause inline: checkStall reports buffering first, then a real pause.
  player.prevAt = performance.now() - 1000; player.prevT = 40; player._playing = true;
  player.pausedOverride = null; player.seekingTarget = null; player.buffering = false; player.pauseReported = false;
  player.onMessage({ source: frame.contentWindow, origin: 'https://megaplay.buzz', data: { event: 'time', time: 40, duration: 1420 } });
  assert.notEqual(actions.at(-1).action, 'pause');
  player.tAt = performance.now() - 1500; player.checkStall();
  assert.equal(player.buffering, true); assert.equal(player.readyState, 2); // short stall = buffering, room waits
  player.tAt = performance.now() - 4000; player.checkStall();
  assert.equal(actions.at(-1).action, 'pause'); assert.equal(player.paused, true); // long stall = real pause
  player.onMessage({ source: frame.contentWindow, origin: 'https://evil.example', data: { event: 'time', time: 99, duration: 1420 } });
  assert.equal(player.currentTime, 40);
  const media = read('public/js/media.js'), css = read('public/css/app.css'), app = read('public/js/app.js'), page = read('public/index.html');
  assert.doesNotMatch(media, /GET_TIME/);
  assert.match(css, /\.stage\[data-kind="megaplay"\] \.controls \{ display: none !important; \}/);
  assert.match(css, /\.stage\[data-kind="megaplay"\] \.anime-social \{ display: flex; \}/);
  assert.match(page, /id="animeCamBtn"[\s\S]*id="animeMicBtn"[\s\S]*id="animeReactBtn"[\s\S]*id="animeChatBtn"/);
  assert.match(page, /id="animeNext"/);
  assert.doesNotMatch(page, /id="animeFsBtn"/); // one fullscreen control: MegaPlay's own, bridged to the stage
  assert.match(media, /m\.megaCommand === 'toggleFullscreen'/);
  assert.match(app, /onFullscreen: cmd =>/);
  assert.match(media, /SKP_DATA/);
  assert.doesNotMatch(app, /kindOf\(S\.movie\) === 'megaplay' && \[' ', 'k', 'f'/);
  assert.match(app, /kindOf\(S\.movie\) === 'megaplay'.*'arrowleft'/);
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
  const app = read('public/js/app.js');
  assert.doesNotMatch(app, /Phones and tablets can't run extensions/);
  const appleFlow = app.slice(app.indexOf("} else if (!remote.present && PLATFORM.appleMobile)"), app.indexOf("} else if (!remote.present && PLATFORM.safari)"));
  assert.match(appleFlow, /Install Watch Party Sync/);
  assert.match(appleFlow, /Settings → Apps → Safari → Extensions/);
  assert.match(appleFlow, /data-copy="\$\{esc\(location\.href\)\}"/);
  assert.doesNotMatch(appleFlow, /href="\$\{esc\(m\.url\)\}"|manual sync|follow-clock/);
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
  const app = read('public/js/app.js');
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
    loadSource(url) { this.url = url; }
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
  const ffprobe = path.join(ROOT, 'bin', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
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
  const ffmpeg = path.join(ROOT, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  const ffprobe = path.join(ROOT, 'bin', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
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

test('room keys, permissions, URL selection, public data, and timeline commands work', async t => {
  const { Room, randKey, PERMS, REACTIONS } = require('../server/room');
  assert.match(randKey(24), /^[A-Za-z0-9]{24}$/); assert.equal(new Set(PERMS).size, 4); assert.ok(REACTIONS.includes('👏'));
  const library = { playable: id => id === 'movie'
    ? { id, title: 'Movie', file: 'D:\\private\\movie.mp4', duration: 100, subs: [] }
    : id === 'live' ? { id, title: 'Live', file: null, duration: 100, hls: true, progressive: true, subs: [] } : null,
  list: () => ({ folders: ['D:\\private'], scanning: false, items: [{ id: 'movie', rel: 'secret\\movie.mp4' }] }) };
  const room = new Room({ config: { adminKey: 'admin-secret-key', roomKey: 'guestsecretkey1234', safariExtensionUrl: 'https://testflight.apple.com/join/AbCd1234', room: {} }, library, save() {}, animeSearch: async q => [{ id: 151801, title: q }],
    // ep 2 resolves to a native HLS stream; anything else fails to resolve (exercises the iframe fallback)
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
  assert.equal(room.movie.episode, 3);
  assert.equal(room.movie.kind, 'megaplay', 'when no stream resolves it falls back to the iframe embed');
  assert.match(room.movie.url, /\/3\/dub$/);
  const beforeCustom = room.movie.id;
  room.selectUrl(guest, 'https://example.com/watch', false, { custom: true });
  assert.equal(room.movie.id, beforeCustom, 'arbitrary custom sites remain host-only');
  room.onMessage(guest, { type: 'lib-list' });
  assert.equal(guestMessages.at(-1).library.items[0].rel, 'movie.mp4');
  room.onMessage(guest, { type: 'anime-search', q: 'Mashle' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(guestMessages.at(-1).type, 'anime-results'); assert.equal(guestMessages.at(-1).results[0].title, 'Mashle');
  assert.equal(room.guestLibrary().folders[0], '(the host\'s movies)'); assert.equal(room.guestLibrary().items[0].rel, 'movie.mp4');
  assert.equal(room.publicSettings(false).safariExtensionUrl, 'https://testflight.apple.com/join/AbCd1234');
  const app = read('public/js/app.js');
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
  const app = read('public/js/app.js');
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

  const originalFetch = global.fetch;
  let redirectCalls = 0;
  global.fetch = async () => { redirectCalls++; return { status: 302, headers: new Headers({ location: 'http://127.0.0.1/private' }) }; };
  try {
    await assert.rejects(remoteMedia.fetchUpstream({ url: 'https://8.8.8.8/source', headers: {} }), /blocked host/);
    assert.equal(redirectCalls, 1, 'a redirect to a private host is rejected before it is fetched');
  } finally { global.fetch = originalFetch; }
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
    webNavigation: { onCreatedNavigationTarget: event(), onDOMContentLoaded: event(), getAllFrames: async () => [] }, scripting: { executeScript: async () => {} }, windows: { get: async () => ({}), update: async () => {} },
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
    webNavigation: { onCreatedNavigationTarget: event(), onDOMContentLoaded: event(), getAllFrames: async () => [] }, scripting: { executeScript: async () => {} }, windows: { get: async () => ({}), update: async () => {} },
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
  assert.match(index, /if \(!pl\?\.file\) return missing\(\)/);
  assert.doesNotMatch(index, /-Message \$\{JSON\.stringify/);
  assert.ok(!fs.existsSync(path.join(ROOT, 'extension/popup.html')));
  assert.ok(!fs.existsSync(path.join(ROOT, 'extension/popup.js')));
  assert.doesNotMatch(`${read('public/css/app.css')}\n${read('README.md')}\n${read('bin/README.txt')}`, /tunnel-box|link-seg|tile\.speaking|Start Watch Party\.bat/);
});
