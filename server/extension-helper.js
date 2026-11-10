'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const install = require('./extension-install');

function message(text, question = false) {
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  const script = `Add-Type -AssemblyName PresentationFramework; $text=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $answer=[System.Windows.MessageBox]::Show($text,'Watch Party Sync',${question ? "'YesNo','Question'" : "'OK','Information'"}); if ($answer -eq 'Yes') { exit 0 } else { exit 1 }`;
  try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore' }); return true; }
  catch { return false; }
}
function register(loc, executable = process.execPath) {
  install.safePath(loc.base, loc.helper);
  fs.mkdirSync(loc.home, { recursive: true });
  if (path.resolve(executable).toLowerCase() !== path.resolve(loc.helper).toLowerCase()) fs.copyFileSync(executable, loc.helper);
  const key = 'HKCU\\Software\\Classes\\watchparty-sync';
  for (const args of [
    ['add', key, '/ve', '/d', 'URL:Watch Party Sync updater', '/f'],
    ['add', key, '/v', 'URL Protocol', '/d', '', '/f'],
    ['add', key + '\\shell\\open\\command', '/ve', '/d', `"${loc.helper}" --extension-helper -- "%1"`, '/f'],
  ]) execFileSync('reg.exe', args, { windowsHide: true, stdio: 'ignore' });
}
function bundledArchive() { return require('./assets').get('ext/watch-party-sync.zip')?.body; }
function showFolder(directory) {
  const explorer = spawn(path.join(process.env.SystemRoot, 'explorer.exe'), [directory], { detached: true, stdio: 'ignore', windowsHide: true });
  explorer.on('error', () => {}); explorer.unref();
}
function syncBundled() {
  if (process.platform !== 'win32') return;
  const loc = install.locations(), state = install.readState(loc);
  if (!state.installed || !state.autoUpdate) return;
  install.recover(loc);
  const bytes = bundledArchive();
  if (!bytes) return;
  const current = JSON.parse(fs.readFileSync(path.join(loc.directory, 'manifest.json'), 'utf8')).version;
  if (install.unpack(bytes).manifest.version === current) return;
  // New permissions require an explicit installer confirmation, never startup approval.
  return install.install(bytes, { loc });
}
async function main({ uri = process.argv.find(value => value.startsWith('watchparty-sync:')), confirm = message, loc = install.locations(), executable = process.execPath,
  platform = process.platform, archive = bundledArchive, fetchUpdate = install.download, registerHelper = register, openFolder = showFolder } = {}) {
  if (platform !== 'win32') throw new Error('This installer is for Windows.');
  if (process.argv.includes('--check-package')) return process.stdout.write(JSON.stringify({ version: install.unpack(bundledArchive()).manifest.version, directory: loc.directory }) + '\n');
  let state = install.readState(loc), bytes;
  const first = !state.installed;
  if (!first) install.recover(loc);
  if (first && !confirm(`Install Watch Party Sync and its file updater in ${loc.directory}?\n\nLater updates replace files in this same folder. Updates from a new party address require your approval. Your browser still requires Load unpacked once.`, true)) return { cancelled: true };
  if (uri) {
    const command = new URL(uri);
    if (command.protocol !== 'watchparty-sync:' || command.hostname !== 'update' || command.pathname && command.pathname !== '/') throw new Error('Invalid updater command.');
    const origin = install.originFrom(command.searchParams.get('origin'));
    if (!state.origins?.includes(origin) && !confirm(`Allow ${origin} to supply Watch Party Sync extension updates?\n\nOnly the extension folder will be updated. Only approve a Watch Party host you trust.`, true)) return { cancelled: true };
    bytes = await fetchUpdate(origin, command.searchParams.get('key') || '');
    state.origins = [...new Set([...(state.origins || []), origin])];
  } else bytes = archive();
  if (!bytes) throw new Error('The installer is missing its extension package.');
  let result = install.install(bytes, { loc, permitChanges: first });
  if (result.consentRequired) {
    if (!confirm('This extension update adds permissions:\n\n' + result.added.join('\n') + '\n\nAllow this update?', true)) return { cancelled: true };
    result = install.install(bytes, { loc, permitChanges: true });
  }
  if (first) registerHelper(loc, executable);
  install.saveState(loc, { ...state, installed: true, autoUpdate: true, version: result.version });
  if (first) {
    openFolder(loc.directory);
    confirm(`Extension files are installed in:\n${loc.directory}\n\nIn your browser, open chrome://extensions (Brave also accepts this address), turn on Developer mode, click Load unpacked and paste that folder path. Then reload Watch Party. This browser step is needed only once; later updates use Update extension and Reload page.`);
  }
  return result;
}
module.exports = { main, syncBundled, message, register };
