'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function bundlePackages(root, inputs) {
  const packages = new Map();
  for (const input of inputs) {
    const file = path.resolve(root, input);
    const marker = `${path.sep}node_modules${path.sep}`;
    const index = file.lastIndexOf(marker);
    if (index < 0) continue;
    const parts = file.slice(index + marker.length).split(path.sep);
    const name = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    const directory = path.join(file.slice(0, index + marker.length), name);
    packages.set(name, directory);
  }
  packages.set('hls.js', path.join(root, 'node_modules', 'hls.js'));
  return packages;
}

function supportedNode(version) {
  const [major, minor, patch] = version.replace(/^v/, '').split('.').map(Number);
  const minimum = { 22: [23, 4], 24: [22, 1], 26: [12, 1] }[major];
  return Boolean(minimum && (minor > minimum[0] || (minor === minimum[0] && patch >= minimum[1])));
}

function packageNotices(root, out, winNode, ffmpegBin, inputs, ffmpegVersion) {
  const licenseRoot = path.join(out, 'LICENSES');
  fs.mkdirSync(licenseRoot, { recursive: true });
  const nodeLicense = path.join(path.dirname(winNode), 'LICENSE');
  if (!fs.existsSync(nodeLicense)) throw new Error('Node LICENSE (including bundled dependency notices) is required next to node.exe; run build/prepare-tools.ps1');
  fs.copyFileSync(nodeLicense, path.join(licenseRoot, 'Node-LICENSE.txt'));
  fs.copyFileSync(path.join(root, 'public', 'data', 'emoji.LICENSE.txt'), path.join(licenseRoot, 'Unicode-LICENSE.txt'));
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'));
  fs.copyFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(out, 'THIRD_PARTY_NOTICES.md'));
  const packages = [];
  for (const [name, directory] of [...bundlePackages(root, inputs)].sort(([a], [b]) => a.localeCompare(b))) {
    const info = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    const notices = fs.readdirSync(directory).filter(file => /^(?:licen[sc]e|copying|notice)(?:[.\-_]|$)/i.test(file) && fs.statSync(path.join(directory, file)).isFile());
    if (!notices.length) throw new Error(`Missing dependency license: ${name}`);
    const target = path.join(licenseRoot, name.replaceAll('/', '__'));
    fs.mkdirSync(target, { recursive: true });
    for (const file of notices) fs.copyFileSync(path.join(directory, file), path.join(target, file));
    packages.push({ name, version: info.version, license: info.license, notices: notices.map(file => `LICENSES/${path.basename(target)}/${file}`) });
  }
  const ffmpegLicense = path.join(ffmpegBin, '..', 'LICENSE.txt');
  if (!fs.existsSync(ffmpegLicense)) throw new Error('FFmpeg license text is required with the supplied binary');
  fs.copyFileSync(ffmpegLicense, path.join(out, 'bin', 'FFMPEG-LICENSE.txt'));
  const receipt = path.join(ffmpegBin, '..', 'DOWNLOAD.json');
  const binaries = fs.readdirSync(path.join(out, 'bin')).filter(file => /\.(?:exe|dll)$/i.test(file)).sort().map(file => ({ file: `bin/${file}`, bytes: fs.statSync(path.join(out, 'bin', file)).size, sha256: sha256(path.join(out, 'bin', file)) }));
  fs.writeFileSync(path.join(out, 'BUILD-MANIFEST.json'), `${JSON.stringify({
    schema: 1, node: { version: process.versions.node, originalBinarySha256: sha256(winNode), licenseSha256: sha256(nodeLicense) },
    dependencies: packages,
    ffmpeg: { version: ffmpegVersion, download: fs.existsSync(receipt) ? JSON.parse(fs.readFileSync(receipt, 'utf8').replace(/^\uFEFF/, '')) : { provenance: 'Existing local cache; original archive URL and digest were not recorded.' }, correspondingSource: 'Not included. Obtain and provide the complete matching FFmpeg and linked-library sources/build scripts before redistribution.' },
    binaries: [{ file: 'WatchParty.exe', bytes: fs.statSync(path.join(out, 'WatchParty.exe')).size, sha256: sha256(path.join(out, 'WatchParty.exe')) }, ...binaries],
  }, null, 2)}\n`);
}

module.exports = { bundlePackages, packageNotices, supportedNode };
