'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const COMMON = path.join(ROOT, 'extension');
const OVERLAY = path.join(ROOT, 'apple', 'SafariWebExtension');
const STAGE_ROOT = path.join(ROOT, 'dist', '.safari-extension');
const STAGE = path.join(STAGE_ROOT, 'watch-party-safari');
const OUTPUT = path.join(ROOT, 'public', 'ext', 'watch-party-safari-source.zip');
const CHROMIUM_STAGE_ROOT = path.join(ROOT, 'dist', '.chromium-extension');
const CHROMIUM_STAGE = path.join(CHROMIUM_STAGE_ROOT, 'watch-party-sync');
const CHROMIUM_OUTPUT = path.join(ROOT, 'public', 'ext', 'watch-party-sync.zip');

function assertInside(root, target) {
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`unsafe build path: ${target}`);
}

function archiveDirectory(parent, folderName, output) {
  if (process.platform === 'win32') {
    execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-cf', output, folderName], { cwd: parent });
  } else {
    execFileSync('zip', ['-q', '-r', output, folderName], { cwd: parent });
  }
}

function versions() {
  const common = JSON.parse(fs.readFileSync(path.join(COMMON, 'manifest.json'), 'utf8')).version;
  const safari = JSON.parse(fs.readFileSync(path.join(OVERLAY, 'manifest.json'), 'utf8')).version;
  const media = fs.readFileSync(path.join(ROOT, 'public', 'js', 'media.js'), 'utf8');
  const page = /REQUIRED_EXT_VERSION = '([^']+)'/.exec(media)?.[1];
  if (!page || common !== page || safari !== page) throw new Error(`extension version mismatch: Chromium ${common}, Safari ${safari}, page ${page || 'missing'}`);
}

function buildChromium() {
  versions();
  for (const target of [CHROMIUM_STAGE_ROOT, CHROMIUM_OUTPUT]) assertInside(ROOT, target);
  fs.rmSync(CHROMIUM_STAGE_ROOT, { recursive: true, force: true });
  fs.rmSync(CHROMIUM_OUTPUT, { force: true });
  fs.mkdirSync(CHROMIUM_STAGE, { recursive: true });
  fs.cpSync(COMMON, CHROMIUM_STAGE, { recursive: true });
  fs.mkdirSync(path.dirname(CHROMIUM_OUTPUT), { recursive: true });
  archiveDirectory(CHROMIUM_STAGE_ROOT, 'watch-party-sync', CHROMIUM_OUTPUT);
  fs.rmSync(CHROMIUM_STAGE_ROOT, { recursive: true, force: true });
  return CHROMIUM_OUTPUT;
}

function buildSafari() {
  versions();

  for (const target of [STAGE_ROOT, OUTPUT]) assertInside(ROOT, target);
  fs.rmSync(STAGE_ROOT, { recursive: true, force: true });
  fs.rmSync(OUTPUT, { force: true });
  fs.mkdirSync(STAGE, { recursive: true });
  fs.cpSync(COMMON, STAGE, { recursive: true });
  fs.cpSync(OVERLAY, STAGE, { recursive: true });
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });

  archiveDirectory(STAGE_ROOT, 'watch-party-safari', OUTPUT);
  fs.rmSync(STAGE_ROOT, { recursive: true, force: true });
  return OUTPUT;
}

if (require.main === module) console.log('built', buildSafari());
module.exports = { archiveDirectory, buildChromium, buildSafari };
