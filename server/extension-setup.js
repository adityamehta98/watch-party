'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BROWSERS = {
  chrome: ['Google', 'Chrome', 'Application', 'chrome.exe'],
  edge: ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
  brave: ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
};

// Native setup is available only through the local, authenticated host API.
// Launch known executables with argument arrays, never a command supplied by a page.
function createExtensionSetup({ root, platform = process.platform, env = process.env, files = fs, launch = spawn }) {
  const directory = path.join(root, 'extension');
  const browserPath = browser => {
    if (platform !== 'win32' || !Object.hasOwn(BROWSERS, browser)) return null;
    for (const base of [env.LOCALAPPDATA, env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)) {
      const candidate = path.join(base, ...BROWSERS[browser]);
      try { if (files.statSync(candidate).isFile()) return candidate; } catch { /* next location */ }
    }
    return null;
  };
  function info() {
    let version = null;
    try { version = JSON.parse(files.readFileSync(path.join(directory, 'manifest.json'), 'utf8')).version; } catch { return null; }
    return { directory, version, browsers: Object.keys(BROWSERS).filter(browserPath) };
  }
  function start(executable, args) {
    return new Promise((resolve, reject) => {
      const child = launch(executable, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
  }
  async function open({ browser, folder = false } = {}) {
    if (platform !== 'win32') throw new Error('Open the browser extensions page manually on this operating system.');
    if (!info()) throw new Error('The bundled extension is missing. Reinstall Watch Party to restore it.');
    const executable = browserPath(browser);
    if (!executable) throw new Error('This browser was not found in its usual installation folder. Open its extensions page manually.');
    await start(executable, [`${browser}://extensions/`]);
    let folderOpened = false;
    if (folder && env.SystemRoot) {
      try { await start(path.join(env.SystemRoot, 'explorer.exe'), [directory]); folderOpened = true; } catch { /* folder path remains available to copy */ }
    }
    return { ok: true, folderOpened };
  }
  return { info, open };
}

module.exports = { createExtensionSetup };
