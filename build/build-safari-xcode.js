'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { stageSafari } = require('./build-safari-extension');

const ROOT = path.resolve(__dirname, '..');
const APPLE_OUT = path.join(ROOT, 'dist', 'apple');
const SOURCE = path.join(APPLE_OUT, 'web-extension');
const PROJECT = path.join(APPLE_OUT, 'xcode');

function parseOptions(argv = process.argv.slice(2), env = process.env) {
  const value = flag => { const i = argv.indexOf(flag); return i < 0 ? '' : String(argv[i + 1] || ''); };
  const bundleId = value('--bundle-id') || String(env.WP_APPLE_BUNDLE_ID || '');
  if (!/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9-]+){2,}$/.test(bundleId)) throw new Error('Pass a unique reverse-DNS bundle ID with --bundle-id (for example com.example.WatchPartySync).');
  const iosOnly = argv.includes('--ios-only'), macosOnly = argv.includes('--macos-only');
  if (iosOnly && macosOnly) throw new Error('Choose only one of --ios-only or --macos-only. Omit both for iOS, iPadOS and macOS.');
  return { bundleId, platform: iosOnly ? '--ios-only' : macosOnly ? '--macos-only' : '' };
}

function findPackager() {
  for (const name of ['safari-web-extension-packager', 'safari-web-extension-converter']) {
    if (spawnSync('xcrun', ['--find', name], { stdio: 'ignore' }).status === 0) return name;
  }
  throw new Error('Xcode does not provide the Safari Web Extension packager. Update Xcode and its command-line tools.');
}

function buildXcode(options = parseOptions()) {
  if (process.platform !== 'darwin') throw new Error('Xcode project generation runs on macOS. Use npm run build:safari for the App Store Connect upload ZIP on any OS.');
  fs.rmSync(APPLE_OUT, { recursive: true, force: true });
  fs.mkdirSync(APPLE_OUT, { recursive: true });
  stageSafari(SOURCE);
  const args = [findPackager(), SOURCE, '--project-location', PROJECT, '--app-name', 'Watch Party Sync', '--bundle-identifier', options.bundleId,
    '--swift', '--copy-resources', '--no-open', '--no-prompt', '--force'];
  if (options.platform) args.push(options.platform);
  execFileSync('xcrun', args, { stdio: 'inherit' });
  return PROJECT;
}

if (require.main === module) {
  try { console.log('built', buildXcode()); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { parseOptions, buildXcode };
