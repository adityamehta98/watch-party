'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { bundlePackages, packageNotices, supportedNode } = require('../build/package-notices');

test('Windows packaging rejects pre-security and unsupported Node release lines', () => {
  for (const version of ['18.20.8', '20.19.0', '22.22.0', '22.23.3', '24.22.0', '25.9.0', '26.12.0']) assert.equal(supportedNode(version), false, version);
  for (const version of ['v22.23.4', '22.24.0', '24.22.1', '26.12.1']) assert.equal(supportedNode(version), true, version);
});

test('dependency notices follow actual bundle inputs, including scoped and nested packages', () => {
  const root = path.resolve('packaging-fixture');
  const packages = bundlePackages(root, ['server/index.js', 'node_modules/ws/lib/receiver.js', 'node_modules/ws/index.js', 'node_modules/@scope/example/lib/index.js', 'node_modules/parent/node_modules/child/index.js']);
  assert.deepEqual([...packages.keys()], ['ws', '@scope/example', 'child', 'hls.js']);
  assert.equal(packages.get('child'), path.join(root, 'node_modules', 'parent', 'node_modules', 'child'));
  assert.equal(packages.has('qrcode-cli'), false);
});

test('release assembly retains full license texts and records binary integrity and missing provenance', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-party-packaging-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const out = path.join(root, 'out');
  const node = path.join(root, 'tools', 'node.exe');
  const ffmpeg = path.join(root, 'ffmpeg', 'bin');
  const put = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
  put(path.join(root, 'LICENSE'), 'Application MIT notice\n');
  put(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'Third-party notice\n');
  put(node, 'original Node binary');
  put(path.join(path.dirname(node), 'LICENSE'), 'Complete Node and third-party notices\n');
  put(path.join(ffmpeg, '..', 'LICENSE.txt'), 'Full GPL text\n');
  put(path.join(out, 'WatchParty.exe'), 'injected executable');
  put(path.join(out, 'bin', 'ffmpeg.exe'), 'FFmpeg binary');
  for (const name of ['ws', 'hls.js']) {
    put(path.join(root, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.2.3', license: name === 'ws' ? 'MIT' : 'Apache-2.0' }));
    put(path.join(root, 'node_modules', name, name === 'ws' ? 'license' : 'LICENSE'), `${name}: full copyright and license\n`);
  }
  put(path.join(root, 'node_modules', 'hls.js', 'NOTICE'), 'Upstream attribution\n');
  packageNotices(root, out, node, ffmpeg, ['node_modules/ws/index.js'], 'ffmpeg test --enable-gpl --enable-version3');
  assert.equal(fs.readFileSync(path.join(out, 'LICENSES', 'ws', 'license'), 'utf8'), 'ws: full copyright and license\n');
  assert.equal(fs.readFileSync(path.join(out, 'LICENSES', 'hls.js', 'NOTICE'), 'utf8'), 'Upstream attribution\n');
  assert.equal(fs.readFileSync(path.join(out, 'LICENSES', 'Node-LICENSE.txt'), 'utf8'), 'Complete Node and third-party notices\n');
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'BUILD-MANIFEST.json'), 'utf8'));
  assert.deepEqual(manifest.dependencies.map(item => item.name), ['hls.js', 'ws']);
  assert.match(manifest.ffmpeg.download.provenance, /not recorded/);
  assert.match(manifest.ffmpeg.correspondingSource, /Not included/);
  const binary = manifest.binaries.find(item => item.file === 'WatchParty.exe');
  assert.equal(binary.sha256, crypto.createHash('sha256').update('injected executable').digest('hex'));
  fs.unlinkSync(path.join(root, 'node_modules', 'ws', 'license'));
  assert.throws(() => packageNotices(root, out, node, ffmpeg, ['node_modules/ws/index.js'], 'ffmpeg test'), /Missing dependency license: ws/);
});
