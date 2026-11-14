'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { locations } = require('./extension-install');

const BROWSERS = {
  chrome: ['Google', 'Chrome', 'Application', 'chrome.exe'],
  edge: ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
  brave: ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
};

// Native setup is available only through the local, authenticated host API.
// Launch known executables with argument arrays, never a command supplied by a page.
function createExtensionSetup({ root, platform = process.platform, env = process.env, files = fs, launch = spawn, installer = null }) {
  const bundled = path.join(root, 'extension');
  let managed;
  try { managed = locations(env.LOCALAPPDATA).directory; } catch { /* non-Windows source mode */ }
  const browserPath = browser => {
    if (platform !== 'win32' || !Object.hasOwn(BROWSERS, browser)) return null;
    for (const base of [env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)) {
      const candidate = path.join(base, ...BROWSERS[browser]);
      try { if (files.statSync(candidate).isFile()) return candidate; } catch { /* next location */ }
    }
    return null;
  };
  function info() {
    let directory = bundled;
    try { if (managed && files.statSync(path.join(managed, 'manifest.json')).isFile()) directory = managed; } catch { /* not installed yet */ }
    let version = null;
    try { version = JSON.parse(files.readFileSync(path.join(directory, 'manifest.json'), 'utf8')).version; } catch { return null; }
    return { directory, managedDirectory: managed, version, canInstall: !!installer, browsers: Object.keys(BROWSERS).filter(browserPath) };
  }
  function start(executable, args) {
    return new Promise((resolve, reject) => {
      const child = launch(executable, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
  }
  async function open({ folder = false } = {}) {
    if (platform !== 'win32') throw new Error('Open the browser extensions page manually on this operating system.');
    if (!info()) throw new Error('The bundled extension is missing. Reinstall Watch Party to restore it.');
    if (!folder) throw new Error('Open extension settings in your current browser using its extension or the copied address.');
    let folderOpened = false;
    if (folder && env.SystemRoot) {
      try { await start(path.join(env.SystemRoot, 'explorer.exe'), [info().directory]); folderOpened = true; } catch { /* folder path remains available to copy */ }
    }
    return { ok: true, folderOpened };
  }
  async function install() {
    if (platform !== 'win32' || !installer) throw new Error('Use the Windows installer download.');
    await start(installer, ['--extension-helper']);
    return { ok: true };
  }
  return { info, open, install };
}

module.exports = { createExtensionSetup };
