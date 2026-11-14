// Streaming services through the Watch Party Sync extension: setup, updates, the side panel and the in-window theater.
import { openYouTube } from './browse.js';
import { noPerm, seekBy, sendCmd, togglePlay } from './controls.js';
import { $, $$, M, S, api, app, canControl, clientId, conn, esc, fmtTime, isCustom, isHost, isTheater, key, kindOf, localPos, mesh, player, remote, stage, store, ytMedia } from './core.js';
import { refreshInfoSoon } from './host.js';
import { placeTiles, sendReaction, setTab, toast, togglePip } from './social.js';
import { LATEST_EXT_VERSION, SERVICE_COLORS, SERVICE_HOMES, SERVICE_NAMES, canonicalUrl, extOutdated, isTitlePage, serviceOfUrl } from '../media.js';
import { PLATFORM } from '../platform.js';

function serviceName(movie) { return (movie && (movie.serviceName || SERVICE_NAMES[movie.service])) || 'the service'; }
function openNetflixInParty() {
  if (S.movie?.service !== 'netflix' || isTheater || S.netflixExternal || S.netflixTheaterFailed ||
      !remote?.present || extOutdated(remote.version) || (remote.access?.service === 'netflix' && remote.access.allowed === false)) return;
  enterTheater();
}
function openNetflixSeparate() {
  if (S.movie?.service !== 'netflix' || (!isTheater && !S.netflixTheaterFailed) || S.netflixExternal) return;
  S.netflixExternal = true;
  remote.openTab();
  theaterReportSoon(); renderServicePanel();
}
function extensionBrowser() { return /Edg\//.test(navigator.userAgent) ? 'edge' : navigator.brave ? 'brave' : 'chrome'; }
const extensionFolder = () => isHost && S.info?.extensionSetup?.managedDirectory || '%LOCALAPPDATA%\\WatchParty\\SyncExtension';
function extensionTargetVersion() {
  const version = S.extPackage?.version;
  return /^\d{1,5}(?:\.\d{1,5}){0,3}$/.test(version || '') && extOutdated(LATEST_EXT_VERSION, version) ? version : LATEST_EXT_VERSION;
}
async function refreshExtensionPackage() {
  try {
    const response = await fetch('/extension/update-info', { cache: 'no-store' });
    if (!response.ok) return;
    S.extPackage = await response.json();
    renderServicePanel(); checkExtensionUpdate();
  } catch { /* The next connection or periodic check can retry. */ }
}
async function checkExtensionUpdate() {
  renderExtensionUpdate();
  if (!remote?.present || !extOutdated(remote.version, extensionTargetVersion())) return;
  const target = extensionTargetVersion(), version = remote.version, stamp = `${version}|${target}`;
  if (S.extWarned !== stamp) {
    S.extWarned = stamp;
    toast(`Extension update available: ${version} → ${target}. Click Update extension to install it.`, { timeout: 20000,
      actions: [{ label: 'Update extension', primary: true, run: () => updateExtension() }] });
  }
  if (!remote.canUpdate || S.extUpdate?.busy || S.extProbeKey === stamp) return;
  S.extProbeKey = stamp;
  // This reads the installed files; it never launches the native helper or
  // requests a store download. Ready files can finish on an ordinary page reload.
  const result = await remote.updateExtension('check', target, { passive: true });
  if (remote.version !== version || extensionTargetVersion() !== target || S.extUpdate?.busy) return;
  if (result.status !== 'ready') return;
  S.extUpdate = { busy: true, message: 'Finishing the installed extension update…' };
  renderExtensionUpdate();
  const applied = await remote.updateExtension('apply', target);
  if (applied.status !== 'reloading') {
    S.extUpdate = { ready: true, message: applied.error || 'New files are installed. Click Reload page to finish.' };
    renderExtensionUpdate();
  }
}
function renderExtensionUpdate() {
  const available = !!remote?.present && extOutdated(remote.version, extensionTargetVersion());
  if (remote?.present && !available) {
    S.extUpdate = null;
    const dialog = $('#extensionUpdateDialog');
    if (dialog.open) dialog.close();
  }
  const button = $('#extensionUpdateBtn');
  button.hidden = !available;
  button.disabled = !!S.extUpdate?.busy;
  button.textContent = S.extUpdate?.busy ? 'Updating…' : S.extUpdate?.ready ? 'Reload to update' : 'Update extension';
  button.title = available ? `Installed ${remote.version}; latest ${extensionTargetVersion()}` : 'Extension is up to date';
  const body = $('#extensionUpdateBody');
  const { installer, installSteps } = extensionSetupUi();
  const manual = S.extUpdate?.manual;
  body.innerHTML = `<p>Installed: <b>${esc(remote?.version || 'Not detected')}</b> · Latest: <b>${esc(extensionTargetVersion())}</b></p>
    <p role="status">${esc(S.extUpdate?.message || 'A newer extension is available. Playback can continue while you choose when to update.')}</p>
    ${available ? `<button class="btn primary" type="button" data-svc="extension-update" ${S.extUpdate?.busy ? 'disabled' : ''}>${S.extUpdate?.busy ? 'Please wait…' : S.extUpdate?.ready ? 'Reload page' : 'Update extension'}</button>` : ''}
    ${manual ? `<p>${S.extUpdate.unmanaged ? 'The browser is using a copy outside the updater’s folder. Installing the Windows helper does not move that browser entry.' : 'Check whether the browser or updater is waiting for your approval.'} If you already installed the helper, skip the installer download and check the folder in the browser steps below.</p>${installer}${installSteps()}` : ''}`;
}
async function runNativeExtensionUpdate() {
  const url = new URL('watchparty-sync://update');
  url.searchParams.set('origin', location.origin);
  if (!isHost) url.searchParams.set('key', key);
  location.href = url.href;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    const result = await remote.updateExtension('check', extensionTargetVersion());
    if (result.status === 'ready') return result;
    if (result.status === 'error') return result;
  }
  return { status: 'manual', error: 'The updater has not finished. Complete its approval window, or install it using the steps below.' };
}

async function updateExtension() {
  if (S.extUpdate?.busy) return;
  if (remote?.present && !extOutdated(remote.version, extensionTargetVersion())) { renderExtensionUpdate(); return; }
  const dialog = $('#extensionUpdateDialog');
  if (dialog && !dialog.open) dialog.showModal();
  const applying = !!S.extUpdate?.ready;
  S.extUpdate = { busy: true, message: applying ? 'Reloading…' : 'Checking for the new extension…' };
  renderServicePanel(); renderExtensionUpdate();
  let result = await remote.updateExtension(applying ? 'apply' : 'check', extensionTargetVersion());
  if (result.status === 'native') {
    S.extUpdate.message = 'Updating the extension files. Approve the updater if your browser asks.';
    renderServicePanel(); renderExtensionUpdate();
    result = await runNativeExtensionUpdate();
  }
  if (result.status === 'reloading') return; // the new extension reloads the affected party and service tabs
  const messages = {
    ready: 'The update is ready. Reload this page to finish.',
    throttled: 'The browser is checking too often. Please try again in a few minutes.',
    no_update: 'The new extension is not available from the browser store yet. Please try again later.',
    manual: result.error || 'Set up the file updater once using the steps below. Future updates use this button.',
  };
  S.extUpdate = { ready: result.status === 'ready', manual: result.status === 'manual', unmanaged: result.status === 'manual' && !result.error,
    message: messages[result.status] || result.error || 'Could not update the extension. Please try again.' };
  renderServicePanel(); renderExtensionUpdate();
  if (kindOf(S.movie) !== 'service') toast(S.extUpdate.message, { timeout: 15000,
    actions: S.extUpdate.ready ? [{ label: 'Reload page', primary: true, run: () => updateExtension() }] : [] });
}

function extensionSetupUi() {
  const copy = (text, label) => `<button class="btn sm" type="button" data-copy="${esc(text)}">${esc(label || 'Copy')}</button>`;
  const addr = `${extensionBrowser()}://extensions`;
  const dir = S.info?.extensionDir;
  const setupButton = (folder = false) => folder
    ? isHost && dir ? '<button class="btn" type="button" data-svc="extension-setup">Open extension folder</button>' : ''
    : remote.canSettings ? '<button class="btn" type="button" data-svc="extension-settings">Open extension settings</button>' : copy(addr, 'Copy extensions address');
  const zip = '<a class="btn sm" href="/ext/watch-party-sync.zip" download>Download extension ZIP</a>';
  const installer = isHost && S.info?.extensionSetup?.canInstall
    ? '<button class="btn primary" type="button" data-svc="extension-install">Install extension files</button>'
    : S.extPackage?.helper && /Windows/.test(navigator.userAgent)
      ? '<a class="btn primary" href="/ext/WatchPartyExtensionSetup.exe" download>Download Windows installer</a>' : '';
  const installSteps = () => `<ol class="svc-steps">
    ${installer ? `<li>${isHost ? 'Click <b>Install extension files</b>, then approve the installer window.' : 'Click <b>Download Windows installer</b>, open <b>WatchPartyExtensionSetup.exe</b> from your browser’s downloads, then approve the installer.'} It always installs to <code>${esc(extensionFolder())}</code> ${copy(extensionFolder(), 'Copy folder')}.</li>` : `<li>${zip} and extract it to a permanent folder. For automatic file updates, use the Windows installer from the packaged Watch Party app.</li>`}
    <li>Copy <code>${addr}</code> ${copy(addr)} into a new tab’s address bar and press Enter. ${remote.canSettings ? setupButton() : ''}</li>
    <li>Turn on <b>Developer mode</b> (top right in Chrome or Brave; left side in Edge).</li>
    <li>If an older <b>Watch Party Sync</b> copy is listed from another folder, turn it <b>off</b> first. Click <b>Load unpacked</b>. ${installer ? `Paste <code>${esc(extensionFolder())}</code> ${copy(extensionFolder(), 'Copy folder')} into the folder picker’s address bar, press Enter, then click <b>Select Folder</b>.` : 'Select the extracted extension folder containing <b>manifest.json</b>.'} Keep only this copy enabled.</li>
    <li>Return here and <button class="btn sm" type="button" data-svc="extension-page-reload">Reload page</button>. After the first setup, use <b>Update extension → Reload page</b>; keep the same folder.</li>
  </ol>`;
  return { zip, installer, installSteps, setupButton };
}
function renderServicePanel() {
  const panel = $('#servicePanel');
  const m = S.movie;
  stage.classList.toggle('service-setup', !!m && kindOf(m) === 'service' && !(remote && remote.present));
  if (!m || kindOf(m) !== 'service') { panel.hidden = true; return; }
  panel.hidden = false;
  const name = serviceName(m);
  const st = remote && remote.st;
  const { zip, installer, installSteps, setupButton } = extensionSetupUi();
  const updateButton = () => `<button class="btn primary" type="button" data-svc="extension-update" ${S.extUpdate?.busy ? 'disabled' : ''}>${S.extUpdate?.busy ? 'Please wait…' : S.extUpdate?.ready ? 'Reload page' : 'Update extension'}</button>`;
  let status, button = '', help = '';
  if (!remote.present && (PLATFORM.mobile || PLATFORM.safari)) {
    const hostName = (S.people.find(p => p.role === 'host') || {}).name || 'The host';
    status = `<div class="follow-clock"><span id="followState"></span><b id="followTime"></b></div>${esc(hostName)} is watching <b>${esc(m.title && m.title !== name ? m.title : 'something')}</b> on ${esc(name)}.`;
    button = `<a class="btn primary" href="${esc(m.url)}" target="_blank" rel="noopener">Open ${esc(name)}</a>`;
    help = '<p class="fine">Streaming-service sync requires Chrome, Edge or Brave on a computer. On this browser, open the service separately and follow the live clock; chat and reactions remain available here. Anime and local movies play directly in Watch Party.</p>';
  } else if (!remote.present) {
    if (isHost) {
      if (!S.info) refreshInfoSoon();
      status = `Set up <b>Watch Party Sync</b> once to watch together on ${esc(name)}. The Windows installer uses the same permanent folder for every update.`;
      button = installer;
      help = installSteps() + `<p class="fine">Manual fallback: ${zip} ${setupButton(true)}</p>`;
    } else {
      status = `To watch together on ${esc(name)}, add the free <b>Watch Party Sync</b> extension (one time, about two minutes, Chrome or Edge on a computer). You'll sign in with your own ${esc(name)} account.`;
      button = installer;
      help = installSteps() + `<p class="fine">Manual fallback: ${zip}. Everyone signs in to ${esc(name)} with their own account.</p>`;
    }
  } else if (extOutdated(remote.version)) {
    status = esc(S.extUpdate?.message || 'Your extension is old. Click below to get the new extension.');
    button = updateButton();
    help = `<p class="fine">${zip} ${setupButton()} <button class="btn sm" type="button" data-svc="extension-page-reload">Reconnect page</button></p>`;
    if (S.extUpdate?.manual) help += `<div class="row" style="justify-content:center">${installer}</div>` + installSteps();
  } else if (remote.access?.allowed === false && remote.access.service === m.service) {
    status = `Watch Party Sync needs site access to connect to ${esc(name)}.`;
    button = setupButton() + '<button class="btn" type="button" data-svc="extension-access">Check again</button>';
    help = `<p class="fine">In the extension’s <b>Site access</b> section, add <code>${esc(remote.access.origin)}</code> to the allowed sites. Then reload the ${esc(name)} page and click <b>Check again</b>. Access to localhost alone does not allow Netflix synchronization.</p>`;
  } else if (m.service === 'netflix' && S.netflixTheaterFailed && !S.netflixExternal) {
    status = 'Netflix could not open inside Watch Party.';
    button = '<button class="btn primary" type="button" data-svc="theater">Retry in Watch Party</button><button class="btn" type="button" data-svc="netflix-separate">Open in separate tab</button>';
  } else if (!remote.linked || !st) {
    const hostName = (S.people.find(p => p.role === 'host') || {}).name || 'The host';
    status = isHost || m.browsing
      ? `Open ${esc(name)} and sign in with <b>your own</b> account if it asks. Press play on anything: the whole room follows what you're watching${isHost ? '' : `, ${esc(hostName)} included`}, and the party (chat, cameras, controls) sits in a panel next to it.`
      : `${esc(hostName)} is watching <b>${esc(m.title && m.title !== name ? m.title : 'something')}</b> on ${esc(name)}. Open it and sign in with <b>your own</b> ${esc(name)} account if it asks. Once the video starts, it follows the room automatically, and the party sits in a panel next to it.`;
    button = isTheater ? '' : `<button class="btn primary" type="button" data-svc="theater">Watch here, in this window</button><button class="btn" type="button" data-svc="open">Open ${esc(name)} in its own tab</button>`;
    help = `<p class="fine">Already have it open in another tab? Just press play there and it links up.</p>`;
    if (m.service === 'netflix') {
      if (!isTheater && !S.netflixExternal) status = 'Opening Netflix in Watch Party…';
      button = S.netflixExternal ? '<button class="btn" type="button" data-svc="show">Show Netflix tab</button>' : '';
      help = '';
    }
    if (isCustom()) {
      // any website the host opened: it plays inside the Watch Party window, and only the host drives it
      status = isHost
        ? `<b>${esc(name)}</b> opens right here for everyone. Pick a video and press play: it plays for the whole room, in sync. Only you control it.`
        : `${esc(hostName)} opened <b>${esc(name)}</b>. Click <b>Watch here</b>: it opens in this window and plays along with ${esc(hostName)}. Only the host controls it.`;
      button = isTheater ? '' : `<button class="btn primary" type="button" data-svc="theater">Watch here, in this window</button>`;
      help = `<p class="fine">If the video doesn't start by itself, click play once inside it. The browser sometimes needs one click there.</p>`;
    }
  } else {
    status = `<span class="svc-ok">Synced with your ${esc(name)} tab</span> · <span id="svcTime"></span>`;
    if (m.browsing) status = `<span class="svc-ok">${esc(name)} is open</span> · press play on anything and everyone follows.`;
    if (st.ad) status += `<br>An ad is playing in your tab. The room waits until it's over.`;
    if (st.blocked) status += `<br>Click play once inside the ${esc(name)} tab. The browser needs one click there.`;
    button = `<button class="btn primary" type="button" data-svc="panel">Show the party next to ${esc(name)}</button><button class="btn" type="button" data-svc="open">Open ${esc(name)} again</button>`;
    help = `<p class="fine">Watch in the ${esc(name)} tab. The party (chat, cameras, people and the play controls) sits in the panel on the right side of Chrome, next to the video. Closed it? Click the Watch Party icon in Chrome's toolbar, or the button above. Keep this tab open in the background: it's what keeps everyone connected.</p>`;
    if (m.service === 'netflix') {
      button = S.netflixExternal ? '<button class="btn" type="button" data-svc="show">Show Netflix tab</button>' : '';
      help = '';
    }
  }
  if (remote.present && !extOutdated(remote.version) && extOutdated(remote.version, extensionTargetVersion())) {
    help += `<p class="fine">${esc(S.extUpdate?.message || 'A newer extension is available. Your current version can keep watching.')} ${updateButton()} ${zip}</p>`;
    if (S.extUpdate?.manual) help += `<div class="row" style="justify-content:center">${installer}</div>` + installSteps();
  }
  const html = `<div class="svc-card"><div class="svc-name">${esc(name)}</div><h2>${esc(m.title && m.title !== name ? m.title : `Watching on ${name}`)}</h2><p>${status}</p>${button ? `<div class="row" style="justify-content:center">${button}</div>` : ''}${help}</div>`;
  if (panel.innerHTML !== html) panel.innerHTML = html;
}
async function onServiceAction(e) {
  const c = e.target.closest('[data-copy]');
  if (c) {
    const done = () => toast('Copied', { timeout: 1500 });
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(c.dataset.copy).then(done, () => prompt('Copy this:', c.dataset.copy));
    else prompt('Copy this:', c.dataset.copy);
    return;
  }
  const b = e.target.closest('[data-svc]');
  if (b && b.dataset.svc === 'extension-page-reload') { location.reload(); return; }
  if (b && b.dataset.svc === 'extension-access') { remote.checkAccess(); return; }
  if (b && b.dataset.svc === 'extension-update') { await updateExtension(); return; }
  if (b && b.dataset.svc === 'extension-settings') {
    const result = await remote.openSettings();
    if (result.status !== 'opened') toast(`Open ${extensionBrowser()}://extensions in this browser.`, { timeout: 15000 });
    return;
  }
  if (b && b.dataset.svc === 'extension-install' && isHost) {
    try { await api('/api/extension/install', { method: 'POST' }); toast('Complete the installer window, then follow the browser steps shown here.', { timeout: 15000 }); }
    catch (err) { toast(err.message, { kind: 'error', timeout: 10000 }); }
    return;
  }
  if (b && ['extension-setup', 'extension-settings'].includes(b.dataset.svc) && isHost) {
    b.disabled = true;
    try {
      const folder = b.dataset.svc === 'extension-setup';
      const result = await api('/api/extension/setup', { method: 'POST', body: JSON.stringify({ browser: extensionBrowser(), folder }) });
      toast(result.folderOpened ? 'Extension folder opened. Use the copied extensions address in this browser.' : 'Copy the folder path shown here into Load unpacked.', { timeout: 10000 });
    } catch (err) { toast(err.message, { kind: 'error', timeout: 10000 }); }
    finally { b.disabled = false; }
    return;
  }
  if (b && b.dataset.svc === 'open') { togglePip({ keep: true, quiet: true }); remote.openPanel(); remote.openTab(); }
  if (b && b.dataset.svc === 'show') remote.showTab();
  if (b && b.dataset.svc === 'panel') remote.openPanel();
  if (b && b.dataset.svc === 'netflix-separate') openNetflixSeparate();
  if (b && b.dataset.svc === 'theater') { S.netflixTheaterFailed = false; renderServicePanel(); enterTheater(); }
}
$('#servicePanel').addEventListener('click', onServiceAction);
$('#extensionUpdateBody').addEventListener('click', onServiceAction);
$('#extensionUpdateBtn').addEventListener('click', () => updateExtension());

function onRemoteUserAction(m) {
  if (kindOf(S.movie) !== 'service') return;

  if (m.url && canonicalUrl(m.url) !== canonicalUrl(S.movie.url) && !S.movie.browsing && performance.now() - (remote.urlChangedAt || -1e9) < 8000) return;
  if (!canControl()) { toast(isCustom() ? 'Only the host controls this site. Your video follows the host.' : 'Only people the host allows can play, pause or seek. Your tab will follow the room.', { timeout: 3500 }); return; }
  if (remote.st?.ad || !['play', 'pause', 'seek'].includes(m.action)) return;
  const t = Number(m.t);
  if (m.action === 'seek' && Math.abs(t - player.expected()) <= (m.land ? 0.4 : 2)) return;
  // The service already filters seek/loading blips. Forward the confirmed
  // action immediately rather than debouncing it a second time here.
  sendCmd(m.action, t);
}

// The host tells the room the real title and length once the player knows them.
function maybeSendMeta() {
  const m = S.movie;
  if (!(isHost || (m && m.by && m.by === (S.me && S.me.name))) || !m || kindOf(m) === 'file' || !M.isAdapter) return;
  const title = (M === remote ? remote.st && remote.st.title : ytMedia.ready && ytMedia.p.getVideoData && ytMedia.p.getVideoData().title) || '';
  const duration = M.duration || 0;
  if (M === remote && (remote.st?.ad || remote.st?.preview)) return;
  const poster = M === remote ? remote.st?.poster || '' : '';
  const key2 = `${m.id}|${title}|${Math.round(duration)}|${poster}`;
  if (!duration && !title) return;
  if (S.metaSent === key2) return;
  S.metaSent = key2;
  conn.send({ type: 'movie-meta', id: m.id, title, duration, poster });
}
setInterval(maybeSendMeta, 3000);

const dock = { open: false, timer: null, last: '', pc: null, rtcKey: '', cams: [], pendingIce: [] };

function dockSnapshot() {
  const m = S.movie;
  const peopleHere = (S.people || []).filter(p => p.admitted);
  const ownId = S.me?.id || clientId;
  return {
    me: { name: S.me?.name || S.name || '', host: isHost },
    theme: document.documentElement.dataset.theme,
    movie: m ? { title: m.title || '', service: kindOf(m) === 'service' ? serviceName(m) : kindOf(m) === 'youtube' ? 'YouTube' : 'Movie' } : null,
    canControl: canControl(), canChat: isHost || !!S.perms.chat, canReact: isHost || !!S.perms.react, canCam: isHost || !!S.perms.camera,
    reactions: S.reactions || [],
    giphyKey: isHost || S.perms.chat ? S.settings.giphyKey || '' : '',
    people: peopleHere.map(p => ({ id: p.id, name: p.name, host: p.role === 'host', me: p.id === ownId, cam: !!(p.media && p.media.cam), mic: !!(p.media && p.media.mic) })),
    chat: S.chatLog.slice(-80),
    cams: dock.cams,
    myCam: !!S.cam, myMic: !!S.mic,
    waiting: S.state && S.state.waiting ? (S.state.waitingFor || []).filter(n => n !== S.me?.name) : null,
    linked: !!(remote && remote.linked && remote.st), ad: !!(remote && remote.st && remote.st.ad),
    autoSkip: isHost && store.get('wp.autoSkip', true), // only the host's tab presses "Skip intro"; everyone follows it
  };
}
function dockPushSoon() {
  if (!dock.open || dock.timer) return;
  dock.timer = setTimeout(() => { dock.timer = null; dockPush(); }, 120);
}
function dockPush(force) {
  if (!dock.open || !remote) return;
  const ui = dockSnapshot();
  const json = JSON.stringify(ui);
  if (!force && json === dock.last) return;
  dock.last = json;
  remote.post({ type: 'ui', ui });
}
function dockTime() {
  if (!dock.open || !remote || !S.state) return;
  remote.post({ type: 'ui-time', t: { pos: localPos(), dur: S.movie?.duration || M.duration || 0, playing: !!S.state.playing, at: Date.now() } });
}

setInterval(() => { dockPush(); dockTime(); dockRtcSync(); }, 500);
let dockTimeAt = 0;
window.addEventListener('message', e => {
  if (e.source !== window || e.origin !== location.origin || !e.data || e.data.source !== 'wp-ext' || e.data.type !== 'status' || !dock.open) return;
  const t = performance.now();
  if (t - dockTimeAt > 450) { dockTimeAt = t; dockPush(); dockTime(); }
});

function onDockMessage(m) {
  if (m.type === 'dock-state') {
    dock.open = !!m.open;
    if (dock.open) { dock.last = ''; dock.rtcKey = ''; dockPush(true); dockTime(); dockRtcSync(); }
    else { if (dock.pc) { try { dock.pc.close(); } catch {} } dock.pc = null; dock.cams = []; dock.rtcKey = ''; }
    return;
  }
  if (m.type === 'dock-rtc') { onDockRtc(m.data || {}); return; }
  if (m.type !== 'ui-action') return;
  const a = m.action || {};
  switch (a.op) {
    case 'quality': remote.post({ type: 'quality-settings' }); break;
    case 'toggle': togglePlay(); break;
    case 'seek-by': seekBy(Math.max(-600, Math.min(600, Number(a.by) || 0))); break;
    case 'auto-skipped': if (isHost) toast(String(a.what || 'Skipped').slice(0, 60), { timeout: 2500 }); break;
    case 'seek-to': {
      if (!canControl()) { noPerm('playback'); break; }
      const t = Number(a.t);
      if (isFinite(t) && t >= 0) sendCmd('seek', t);
      break;
    }
    case 'chat': {
      const text = String(a.text || '').trim().slice(0, 500);
      if (!text) break;
      if (!(isHost || S.perms.chat)) { noPerm('chat'); break; }
      conn.send({ type: 'chat', text });
      break;
    }
    case 'react': if ((S.reactions || []).includes(a.emoji)) sendReaction(a.emoji); break;
    case 'cam': $('#camBtn').click(); break;
    case 'mic': $('#micBtn').click(); break;
    default:
  }
  dockPushSoon();
}

function dockCamItems() {
  const items = [];
  if (S.cam && mesh && mesh.local.video) items.push({ id: S.me?.id || clientId, track: mesh.local.video, name: 'You', self: true });
  for (const [id, p] of S.peers || []) {
    if (!(p.media && p.media.cam)) continue;
    const st = S.remoteStreams.get(id);
    const tr = st && st.getVideoTracks().find(t => t.readyState === 'live');
    if (tr) items.push({ id, track: tr, name: p.name });
  }
  return items;
}
async function dockRtcSync() {
  if (!dock.open || !remote) return;
  const items = dockCamItems();
  const key = items.map(i => `${i.id}:${i.track.id}`).join(',');
  const broken = dock.pc && ['failed', 'closed'].includes(dock.pc.connectionState);
  if (key === dock.rtcKey && !broken) return;
  dock.rtcKey = key;
  if (dock.pc) { try { dock.pc.close(); } catch {} }
  dock.pc = null;
  dock.cams = [];
  dock.pendingIce = [];
  if (!items.length) { remote.post({ type: 'dock-rtc', data: { none: true } }); dockPush(true); return; }
  const pc = new RTCPeerConnection();
  dock.pc = pc;
  for (const it of items) {
    const ms = new MediaStream([it.track]);
    pc.addTrack(it.track, ms);
    dock.cams.push({ id: it.id, sid: ms.id, name: it.name, self: !!it.self });
  }
  pc.onicecandidate = e => { if (e.candidate && dock.pc === pc) remote.post({ type: 'dock-rtc', data: { ice: e.candidate.toJSON() } }); };
  try {
    await pc.setLocalDescription(await pc.createOffer());
    if (dock.pc !== pc) return;
    remote.post({ type: 'dock-rtc', data: { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp }, cams: dock.cams } });
  } catch (e) { console.warn('panel cameras', e); }
  dockPush(true);
}
async function onDockRtc(d) {
  const pc = dock.pc;
  if (!pc) return;
  try {
    if (d.sdp && d.sdp.type === 'answer') {
      await pc.setRemoteDescription(d.sdp);
      for (const c of dock.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
    } else if (d.ice) {
      if (!pc.remoteDescription) dock.pendingIce.push(d.ice);
      else await pc.addIceCandidate(d.ice).catch(() => {});
    } else if (d.restart) { dock.rtcKey = ''; dockRtcSync(); }
  } catch (e) { console.warn('panel cameras', e); }
}

function enterTheater() {
  if (!remote?.present || isTheater || enterTheater.timer) return;
  const url = `${location.origin}${location.pathname}#wpcid=${encodeURIComponent(clientId)}&wpname=${encodeURIComponent(S.me?.name || S.name || '')}`;
  remote.post({ type: 'theater', url });
  // this page is replaced by the Watch Party window in a moment; still here after a few seconds = it didn't work
  enterTheater.timer = setTimeout(() => extProblem({ kind: 'theater', error: 'nothing happened' }), 4000);
}
// The extension is installed but isn't answering: say what to do instead of silently doing nothing.
function extProblem(p) {
  if (p.kind === 'quality') { toast('This service controls resolution automatically. Use its playback or data-usage settings for the quality options it supports.', { timeout: 5000 }); return; }
  if (p.kind === 'theater') {
    clearTimeout(enterTheater.timer); enterTheater.timer = null;
    if (!isTheater && S.movie?.service === 'netflix') { S.netflixTheaterFailed = true; renderServicePanel(); return; }
  }
  if (p.kind === 'navigation') {
    const actions = isTheater && S.movie?.service === 'netflix' && !S.netflixExternal
      ? [{ label: 'Open in separate tab', run: openNetflixSeparate }] : [];
    toast(p.error || 'The service could not open the room title. Retry from its player.', { kind: 'error', timeout: 20000, actions });
    return;
  }
  const addr = /Edg\//.test(navigator.userAgent) ? 'edge://extensions' : /Brave/.test(navigator.userAgent) || navigator.brave ? 'brave://extensions' : 'chrome://extensions';
  if (p.kind === 'stale') {
    // the extension was reloaded after this page opened: reload the page once to reconnect
    let tried = false; try { tried = sessionStorage.getItem('wp.staleReload') === '1'; sessionStorage.setItem('wp.staleReload', '1'); } catch { /* private window */ }
    if (!tried) { extProblem.reloading = true; clearTimeout(enterTheater.timer); toast('The Watch Party Sync extension was reloaded. Reconnecting this page…', { timeout: 3000 }); setTimeout(() => location.reload(), 1200); return; }
  }
  if (extProblem.reloading) return;
  if (extProblem.shown && Date.now() - extProblem.shown < 8000) return;
  extProblem.shown = Date.now();
  toast(`The Watch Party Sync extension isn't responding${p.error && p.error !== 'stale' ? ` (${p.error})` : ''}. Open ${addr}, click the reload arrow on Watch Party Sync (and send a screenshot of its Errors button if it has one), then reload this page.`,
    { kind: 'error', timeout: 30000, actions: [{ label: 'Reload this page', primary: true, run: () => location.reload() }] });
}
try { if (sessionStorage.getItem('wp.staleReload') === '1') setTimeout(() => { try { sessionStorage.removeItem('wp.staleReload'); } catch {} }, 15000); } catch { /* private window */ }
const theaterSvc = () => isTheater && kindOf(S.movie) === 'service' && !S.netflixExternal;
function theaterPost(msg) {
  if (!isTheater) return;
  const origin = location.ancestorOrigins?.[0];
  if (!/^chrome-extension:\/\/[a-p]{32}$/.test(origin || '')) return;
  try { window.parent.postMessage(msg, origin); } catch { /* not in the window anymore */ }
}
let theaterLast = '', theaterTimer = null;
function theaterReportSoon() { if (isTheater && !theaterTimer) theaterTimer = setTimeout(() => { theaterTimer = null; theaterReport(); }, 30); }
function theaterReport() {
  if (!isTheater) return;
  const show = theaterSvc();
  app.classList.toggle('theater-svc', show);
  // cameras: in the sidebar while the streaming site covers the movie area
  const cams = $('#cams');
  const home = show ? $('#sideCams') : stage;
  if (cams.parentNode !== home) {
    if (show) home.appendChild(cams); else stage.insertBefore(cams, $('#chatFloat'));
    for (const v of cams.querySelectorAll('video')) v.play().catch(() => {});
    placeTiles();
  }
  const r = stage.getBoundingClientRect();
  // a window like Invite is open: the streaming site (which sits on top of this page) steps aside so it can be seen
  const cover = !!document.querySelector('dialog[open]');
  const msg = { wpTheater: 'stage', show, custom: isCustom(), strict: isCustom() && !!S.movie.strict, cover, linked: !!(remote && remote.linked && remote.st), browsing: !!(S.movie && S.movie.browsing), signin: !!(remote && remote.signingIn), transitioning: !!serviceAdvance, current: remote ? canonicalUrl(remote.pageUrl) : '', url: S.movie && S.movie.url, rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } };
  const json = JSON.stringify(msg);
  if (json === theaterLast) return;
  theaterLast = json;
  theaterPost(msg);
  theaterPost({ wpTheater: 'title', text: S.movie ? `${S.movie.title || serviceName(S.movie)} · Watch Party` : 'Watch Party' });
}
if (isTheater) {
  for (const d of $$('dialog')) new MutationObserver(() => theaterReportSoon()).observe(d, { attributes: true, attributeFilter: ['open'] });
  if (window.ResizeObserver) new ResizeObserver(() => theaterReportSoon()).observe(stage);
  window.addEventListener('resize', theaterReportSoon);
  setInterval(theaterReport, 1000);
}

function renderServiceTiles() {
  const cur = S.movie && S.movie.service;
  $('#svcGrid').innerHTML = Object.entries(SERVICE_NAMES).map(([id, name]) => `<button type="button" class="svc-tile ${cur === id ? 'cur' : ''}" data-svc-tile="${id}" style="--svc:${SERVICE_COLORS[id]}" title="Watch together on ${esc(name)}"><span>${esc(name)}${id === 'youtube' ? '<small>no sign-in, plays here</small>' : ''}</span></button>`).join('');
}
renderServiceTiles();
$('#svcGrid').addEventListener('click', e => {
  const b = e.target.closest('[data-svc-tile]');
  if (!b) return;
  const id = b.dataset.svcTile;
  if (id === 'youtube') { openYouTube(); return; }
  if (id === 'netflix') {
    setTab('chat');
    if (!isHost && S.movie?.service === id && !S.movie.browsing) {
      if (S.netflixExternal) remote?.showTab();
      else if (isTheater) theaterPost({ wpTheater: 'goto', url: S.movie.url });
      else openNetflixInParty();
    } else conn.send({ type: 'select-url', url: SERVICE_HOMES[id], browsing: true });
    return;
  }
  if (!isHost && S.movie && kindOf(S.movie) === 'service' && S.movie.service === id && !S.movie.browsing) {
    setTab('chat');
    if (!remote || !remote.present) return; // the panel shows how to add the extension
    if (isTheater) theaterPost({ wpTheater: 'goto', url: S.movie.url });
    else if (!$('#svcNewTab').checked) enterTheater();
    else { togglePip({ keep: true, quiet: true }); remote.openPanel(); remote.openTab(); }
    toast(`Taking you to ${S.movie.title && S.movie.title !== serviceName(S.movie) ? `"${S.movie.title}"` : 'what the room is watching'}…`, { timeout: 3000 });
    return;
  }
  conn.send({ type: 'select-url', url: SERVICE_HOMES[id], browsing: true });
  setTab('chat');
  if (!remote?.present) return; // the panel then shows the install steps
  if (!$('#svcNewTab').checked) {
    // default: right here, inside the Watch Party window
    if (!isTheater) enterTheater();
    return;
  }
  // a separate tab, with the pop-out party and the side panel next to it (they need this click)
  togglePip({ keep: true, quiet: true });
  remote.openPanel();
  remote.post({ type: 'open', service: id, url: SERVICE_HOMES[id] });
});

// Skip intros / credits and play the next episode: the host's own choice, remembered on this PC
{
  const cb = $('#svcAutoSkip');
  cb.checked = store.get('wp.autoSkip', true);
  cb.addEventListener('change', () => { store.set('wp.autoSkip', cb.checked); dockPush(true); });
}

let followTimer = null, lastFollowUrl = '', followBase = '', pendingFollowUrl = '';
function maybeFollowTab() {
  if ((!isHost && isCustom()) || !remote || !remote.linked || !remote.st) return;
  const m = S.movie;
  if (!m || kindOf(m) !== 'service') return;
  const st = remote.st;

  const pageNow = () => (remote.st && remote.st.url) || (m.service === 'custom' ? remote.pageUrl : '') || '';
  const url = canonicalUrl(pageNow());
  if (!url || url === canonicalUrl(m.url) || url === lastFollowUrl || url === followBase || url === pendingFollowUrl) return;
  if (!(st.dur > 60) || st.ad || remote.signingIn) return;
  // A loaded title is a selection even when paused while waiting for friends to join.
  // a home page / browse rows / profile picker / info page plays trailers by itself: never a pick
  if (!isTitlePage(pageNow())) return;

  if (!isHost && !m.browsing && !reachedTitle) return;
  if (m.service === 'custom' ? !!serviceOfUrl(url) : serviceOfUrl(url) !== m.service) return; // wandered off to another site
  pendingFollowUrl = url;
  clearTimeout(followTimer);
  followTimer = setTimeout(() => {
    followTimer = null; pendingFollowUrl = '';
    const current = remote.st;
    if (S.movie?.id !== m.id || !current || !(current.dur > 60) || current.ad || remote.signingIn || canonicalUrl(pageNow()) !== url || (!isHost && isCustom())) return;
    const advanceFrom = m.service === 'netflix' && canonicalUrl(current.advanceFrom) === canonicalUrl(m.url) ? m.url : '';
    const msg = { type: 'select-url', url: m.service === 'custom' ? pageNow() : url, follow: true, advanceFrom, title: current.title || '', duration: current.dur || 0, position: remote.currentTime, playing: !current.paused || (!!current.hold && !!S.state && !!S.state.playing) };
    lastFollowUrl = url;
    conn.send(msg);
  }, 250);
}
window.addEventListener('message', e => {
  if (e.source !== window || !e.data || e.data.source !== 'wp-ext') return;

  if (isHost && conn && e.origin === location.origin) {
    if (e.data.type === 'hello') remote?.post({ type: 'playback-history' });
    if (e.data.type === 'playback-history' && Array.isArray(e.data.entries)) conn.send({ type: 'playback-import', entries: e.data.entries.slice(0, 500) });
  }

  const u = e.data.type === 'page' ? e.data.url : e.data.type === 'status' && e.data.st ? e.data.st.url : '';
  if (followBase && u && canonicalUrl(u) !== followBase) followBase = '';
  if (e.data.type === 'status') maybeFollowTab();
  if (e.data.type === 'status' || e.data.type === 'page') { keepOnTitle(); setTimeout(settleServiceAdvance, 0); }
});
// Guests: when the room's title changes on the service they have open, their tab is taken there.
let lastMovieUrl = '', serviceAdvance = null;
function clearServiceAdvance() {
  if (!serviceAdvance) return;
  clearTimeout(serviceAdvance.timer);
  serviceAdvance = null;
  theaterReportSoon();
}
function settleServiceAdvance() {
  if (!serviceAdvance || canonicalUrl(remote && remote.pageUrl) !== serviceAdvance.to) return false;
  clearServiceAdvance();
  return true;
}
function tryServiceAdvance(movie, previousUrl) {
  const from = canonicalUrl(movie && movie.advanceFrom);
  const to = canonicalUrl(movie && movie.url);
  if (!remote || !remote.linked || movie.service !== 'netflix' || !from || !to || from === to || from !== canonicalUrl(previousUrl) || canonicalUrl(remote.pageUrl) !== from) return false;
  clearServiceAdvance();
  const pending = { from, to, timer: null };
  serviceAdvance = pending;
  remote.advance(movie.url);
  pending.timer = setTimeout(() => {
    if (serviceAdvance !== pending || settleServiceAdvance()) return;
    serviceAdvance = null;
    theaterReportSoon();
    if (!isTheater || S.netflixExternal) remote.navigate(movie.url);
  }, 8000);
  theaterReportSoon();
  return true;
}
function bringAlong(movie) {
  if (!movie || kindOf(movie) !== 'service') { lastMovieUrl = ''; clearServiceAdvance(); return; }
  const prev = lastMovieUrl;
  lastMovieUrl = movie.url;
  if (prev !== movie.url) { followBase = remote ? canonicalUrl(remote.pageUrl || '') : ''; reachedTitle = false; clearTimeout(followTimer); followTimer = null; pendingFollowUrl = ''; lastFollowUrl = ''; }

  if (!remote || !remote.present || movie.browsing) return;
  if (movie.service === 'netflix' && !isTheater && !S.netflixExternal) return; // loadMovie opens it in Watch Party
  if (!prev || prev === movie.url) return;
  if (tryServiceAdvance(movie, prev)) return;
  if (isTheater && !S.netflixExternal) return; // other title changes are handled by the theater frame
  if (remote.signingIn) return; // they're signing in: keepOnTitle takes them there afterwards
  if (!(remote.linked && canonicalUrl(remote.pageUrl) === canonicalUrl(movie.url))) {
    remote.navigate(movie.url);
    toast(`Taking your ${serviceName(movie)} tab to ${movie.title && movie.title !== serviceName(movie) ? `"${movie.title}"` : 'what the host is watching'}…`, { timeout: 5000 });
  }
}

// Phones following a streaming service by hand: a live clock of where the room is.
setInterval(() => {
  const t = $('#followTime');
  if (!t || !S.state) return;
  const playing = !!S.state.playing;
  t.textContent = fmtTime(localPos());
  const label = S.state.waiting ? 'Paused (waiting)' : playing ? 'Playing' : 'Paused';
  const fs = $('#followState');
  // the moment the room plays, pauses or skips, the clock flashes so you notice and do the same
  const sig = `${playing}|${S.state.seq}`;
  if (followSig && sig !== followSig) {
    const box = t.closest('.follow-clock');
    box.classList.remove('flash'); void box.offsetWidth; box.classList.add('flash');
    fs.textContent = playing ? 'Press play now' : 'Pause now';
    followFlashUntil = Date.now() + 3000;
  } else if (Date.now() > followFlashUntil) fs.textContent = label;
  followSig = sig;
  fs.className = playing ? 'good' : 'bad';
}, 250);
let followSig = '', followFlashUntil = 0;

let keepOffSince = 0, keepLastGo = 0, reachedTitle = false;
function keepOnTitle() {
  if (!remote || !remote.present || !S.movie || kindOf(S.movie) !== 'service' || S.movie.browsing) { keepOffSince = 0; return; }
  const want = canonicalUrl(S.movie.url);
  const here = canonicalUrl(remote.pageUrl);
  if (here && here === want && !remote.signingIn && remote.readyState >= 2 && remote.st?.dur > 60 && !remote.st.ad && canonicalUrl(remote.st.url) === want) reachedTitle = true;
  // Anyone who was on the title and then went browsing is picking the next thing: leave them be.
  if (reachedTitle) { keepOffSince = 0; return; }
  const onService = here && (S.movie.service === 'custom' ? !serviceOfUrl(here) : serviceOfUrl(here) === S.movie.service);
  const fresh = remote.page && performance.now() - remote.page.at < 6000;
  if (!want || !onService || !fresh || remote.signingIn || here === want || (remote.linked && remote.st && !remote.st.ad && canonicalUrl(remote.st.url) === want)) { keepOffSince = 0; return; }
  if (!keepOffSince) { keepOffSince = Date.now(); return; }
  // Confirm the unlocked page briefly, then queue the destination in the
  // existing service document. Its own navigation guard checks the PIN again.
  if (Date.now() - keepOffSince < 250 || Date.now() - keepLastGo < 15000) return;
  keepLastGo = Date.now(); keepOffSince = 0;
  toast(`Taking you to ${S.movie.title && S.movie.title !== serviceName(S.movie) ? `"${S.movie.title}"` : 'what the room is watching'}…`, { timeout: 4000 });
  if (isTheater && !S.netflixExternal) theaterPost({ wpTheater: 'goto', url: S.movie.url, custom: isCustom(), strict: isCustom() && !!S.movie.strict });
  else remote.navigate(S.movie.url);
}
setInterval(keepOnTitle, 250);

// top bar camera / mic (the Watch Party window with Netflix & co: the movie controls are hidden there)
$('#tbCam').addEventListener('click', () => $('#camBtn').click());
$('#tbMic').addEventListener('click', () => $('#micBtn').click());

export { bringAlong, checkExtensionUpdate, dockPushSoon, enterTheater, extProblem, maybeSendMeta, onDockMessage, onRemoteUserAction, openNetflixInParty, openNetflixSeparate, refreshExtensionPackage, renderServicePanel, renderServiceTiles, serviceName, theaterPost, theaterReportSoon, theaterSvc };
