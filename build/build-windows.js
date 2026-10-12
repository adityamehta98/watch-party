// Builds dist/WatchParty/ : WatchParty.exe (Node + app + web page in one file) and bin/ffmpeg.
// Usage: node build/build-windows.js <path-to-windows-node.exe> <path-to-ffmpeg-bin-folder>
// The windows node.exe must be the same version as the node running this script.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildChromium, buildSafari } = require('./build-safari-extension');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'WatchParty');
const TMP = path.join(ROOT, 'dist', '.build');
const [winNode, ffmpegBin] = process.argv.slice(2);
const TOOLS = process.env.BUILD_TOOLS || path.join(ROOT, 'node_modules');
if (!winNode || !ffmpegBin) { console.error('usage: node build/build-windows.js node.exe ffmpeg/bin'); process.exit(1); }

fs.rmSync(OUT, { recursive: true, force: true });
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'bin'), { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

// 1) bundle the server into one file
const esbuild = require(path.join(TOOLS, 'esbuild'));
esbuild.buildSync({
  entryPoints: [path.join(ROOT, 'server', 'index.js')],
  bundle: true, platform: 'node', target: 'node22', format: 'cjs',
  outfile: path.join(TMP, 'app.js'),
  external: ['bufferutil', 'utf-8-validate'],
  legalComments: 'none',
});

// 1a) browser extensions: downloadable Chromium/Safari packages, plus the host's Chromium folder
fs.mkdirSync(path.join(ROOT, 'public', 'ext'), { recursive: true });
buildChromium();
fs.cpSync(path.join(ROOT, 'extension'), path.join(OUT, 'extension'), { recursive: true });
buildSafari();

// 2) embed the web page files
const assets = {};
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else assets['public/' + path.relative(path.join(ROOT, 'public'), full).split(path.sep).join('/')] = full;
  }
})(path.join(ROOT, 'public'));
assets['public/vendor/hls.min.js'] = path.join(ROOT, 'node_modules', 'hls.js', 'dist', 'hls.light.min.js');
assets['public/vendor/hls.LICENSE.txt'] = path.join(ROOT, 'node_modules', 'hls.js', 'LICENSE');
const seaConfig = {
  main: path.join(TMP, 'app.js'), output: path.join(TMP, 'sea.blob'),
  disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, assets,
};
fs.writeFileSync(path.join(TMP, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', path.join(TMP, 'sea-config.json')], { stdio: 'inherit' });

// 3) inject into a copy of the Windows node.exe. Strip its Authenticode signature first (clear the
// Certificate Table and drop the appended cert blob) or postject refuses to add the SEA resource.
function stripPeSignature(src, dst) {
  const b = fs.readFileSync(src);
  const pe = b.readUInt32LE(0x3c);
  if (b.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('not a PE file');
  const dirs = pe + 24 + (b.readUInt16LE(pe + 24) === 0x20b ? 112 : 96);
  const sec = dirs + 4 * 8; // IMAGE_DIRECTORY_ENTRY_SECURITY
  const off = b.readUInt32LE(sec), size = b.readUInt32LE(sec + 4);
  b.writeUInt32LE(0, sec); b.writeUInt32LE(0, sec + 4);
  fs.writeFileSync(dst, off && size && off + size <= b.length ? b.subarray(0, off) : b);
}
const exe = path.join(OUT, 'WatchParty.exe');
stripPeSignature(winNode, exe);
execFileSync(process.execPath, [path.join(TOOLS, 'postject', 'dist', 'cli.js'), exe, 'NODE_SEA_BLOB', path.join(TMP, 'sea.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'], { stdio: 'inherit' });

// 3b) run without a console window: switch the exe to the Windows "GUI" subsystem.
// (Everything it would have printed goes to cache\watchparty.log instead.)
{
  const buf = fs.readFileSync(exe);
  const pe = buf.readUInt32LE(0x3c);
  if (buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('not a PE file');
  const subsystemAt = pe + 24 + 68; // same offset for 32- and 64-bit optional headers
  const before = buf.readUInt16LE(subsystemAt);
  if (before !== 3 && before !== 2) throw new Error(`unexpected subsystem ${before}`);
  buf.writeUInt16LE(2, subsystemAt);
  fs.writeFileSync(exe, buf);
  console.log(`subsystem ${before} -> 2 (no console window)`);
}

// 4) ffmpeg (exe + dlls), docs
for (const f of fs.readdirSync(ffmpegBin)) {
  if (/^(ffmpeg|ffprobe)\.exe$/i.test(f) || /\.dll$/i.test(f)) fs.copyFileSync(path.join(ffmpegBin, f), path.join(OUT, 'bin', f));
}
const lic = path.join(ffmpegBin, '..', 'LICENSE.txt');
if (fs.existsSync(lic)) fs.copyFileSync(lic, path.join(OUT, 'bin', 'FFMPEG-LICENSE.txt'));
fs.copyFileSync(path.join(ROOT, 'README.md'), path.join(OUT, 'README.md'));
fs.rmSync(TMP, { recursive: true, force: true });
console.log('built', OUT);
