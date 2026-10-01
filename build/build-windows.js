// Builds dist/WatchParty/ : WatchParty.exe (Node + app + web page in one file) and bin/ffmpeg.
// Usage: node build/build-windows.js <path-to-windows-node.exe> <path-to-ffmpeg-bin-folder>
// The windows node.exe must be the same version as the node running this script.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

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

// 1a) the page and the extension must agree on the extension version
{
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));
  const media = fs.readFileSync(path.join(ROOT, 'public', 'js', 'media.js'), 'utf8');
  const m = /REQUIRED_EXT_VERSION = '([^']+)'/.exec(media);
  if (!m || m[1] !== manifest.version) { console.error(`extension version mismatch: manifest ${manifest.version}, page expects ${m && m[1]}`); process.exit(1); }
}
// 1b) the browser extension: a zip guests can download from the invite page, plus the folder for the host
fs.mkdirSync(path.join(ROOT, 'public', 'ext'), { recursive: true });
const extZip = path.join(ROOT, 'public', 'ext', 'watch-party-sync.zip');
fs.rmSync(extZip, { force: true });
fs.rmSync(path.join(TMP, 'watch-party-sync'), { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'extension'), path.join(TMP, 'watch-party-sync'), { recursive: true });
execFileSync('zip', ['-q', '-r', extZip, 'watch-party-sync'], { cwd: TMP });
fs.cpSync(path.join(ROOT, 'extension'), path.join(OUT, 'extension'), { recursive: true });

// 2) embed the web page files
const assets = {};
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else assets['public/' + path.relative(path.join(ROOT, 'public'), full).split(path.sep).join('/')] = full;
  }
})(path.join(ROOT, 'public'));
const seaConfig = {
  main: path.join(TMP, 'app.js'), output: path.join(TMP, 'sea.blob'),
  disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, assets,
};
fs.writeFileSync(path.join(TMP, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', path.join(TMP, 'sea-config.json')], { stdio: 'inherit' });

// 3) inject into a copy of the Windows node.exe
const exe = path.join(OUT, 'WatchParty.exe');
fs.copyFileSync(winNode, path.join(TMP, 'node.exe'));
try {
  // the original Node signature would be invalid after injection; remove it
  execFileSync('osslsigncode', ['remove-signature', '-in', path.join(TMP, 'node.exe'), '-out', exe], { stdio: 'ignore' });
} catch { fs.copyFileSync(path.join(TMP, 'node.exe'), exe); }
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
