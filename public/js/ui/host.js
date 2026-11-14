// Host tools: server and invite, room settings, and the library of the host's own movie files.
import { $, $$, S, api, conn, esc, fmtEta, fmtTime, icon, isHost, isTheater, remote, resLabel, room, setHtml, store } from './core.js';
import { enterTheater, renderServicePanel } from './services.js';
import { setTab, toast } from './social.js';
import { maybeFindSubtitles, visuals } from './sources.js';
import { extOutdated } from '../media.js';

let infoTimer = null;
function refreshInfoSoon() { clearTimeout(infoTimer); infoTimer = setTimeout(refreshInfo, 300); }
async function refreshInfo() {
  if (!isHost) return;
  try { S.info = await api('/api/info'); } catch { return; }
  renderServerControls();
  renderInvite();
  renderSettings();
  renderLibrary();
  renderServicePanel();
  if (S.info.updatePending && !S.updateWarned) {
    S.updateWarned = true;
    toast('An update is downloaded but not installed. Close the Watch Party window, then double-click "refresh.bat" (not WatchParty.exe).', { kind: 'error', timeout: 15000 });
  }
}
function renderServerControls() {
  if (!isHost) return;
  const server = S.info?.server;
  const status = server?.status || 'stopped';
  $('#startServer').disabled = !server || status !== 'stopped' || !!S.serverPending;
  $('#stopServer').disabled = !server || !['starting', 'running'].includes(status) || !!S.serverPending;
  $('#serverStatus').textContent = ({ stopped: 'Private player', starting: 'Starting server…', running: 'Server running', stopping: 'Stopping server…' })[status];
  $('#serverDescription').textContent = server?.error ? `Server error: ${server.error}. You can keep watching privately.`
    : status === 'stopped' ? 'Only you can watch. The player stays open until you close its window.'
    : status === 'stopping' ? 'Disconnecting guests. Your private player stays open.'
    : 'Sharing stays on until you click Stop server or close the Watch Party window. Inactivity does not stop it.';
}
async function changeServer(action) {
  S.serverPending = true;
  renderServerControls();
  try {
    const server = await api(`/api/server/${action}`, { method: 'POST' });
    S.info = { ...S.info, server };
    await refreshInfo();
  } catch (error) { toast(error.message, { kind: 'error' }); }
  finally { S.serverPending = false; renderServerControls(); }
}
$('#startServer').addEventListener('click', () => changeServer('start'));
$('#stopServer').addEventListener('click', () => changeServer('stop'));
function netSummary(i) {
  if (i.server?.status === 'stopped') return { tone: 'ok', text: 'Private player. Start the server in People when you want to invite guests.' };
  if (i.server?.status === 'stopping') return { tone: 'wait', text: 'Stopping sharing. Your private player stays open.' };
  const n = i.network || {};
  const port = n.port;
  const t = n.tailscale;
  if (t && t.funnel && t.funnel.inUse) return { tone: 'ok', text: 'Using the public link through Tailscale. Anyone with the link can connect, no Tailscale needed. Webcams don\'t work over it.' };
  if (t && t.inUse) return { tone: 'ok', text: `Using your private Tailscale link${t.trusted ? ' (trusted certificate, no browser warning)' : ''}. Only people you've shared this PC with in Tailscale can connect.` };
  switch (n.status) {
    case 'searching': return { tone: 'wait', text: 'Asking your router to open a port…' };
    case 'mapped': return { tone: 'ok', text: `Your router opened port ${n.tcpExternal || port} for Watch Party automatically.` };
    case 'cgnat': return { tone: 'bad', text: n.error || 'Your internet provider shares one public address between customers, so friends can\'t reach this PC directly.' };
    case 'off': return { tone: n.publicHost ? 'ok' : 'bad', text: n.publicHost ? 'Automatic router setup is off. Using the address you entered.' : 'Automatic router setup is off.' };
    case 'no-upnp':
    case 'failed': return { tone: n.publicHost ? 'ok' : 'bad', text: n.publicHost ? `Using the address you entered (${n.publicHost}). Make sure port ${port} is forwarded to this PC.` : 'Your router didn\'t open the port automatically.', detail: n.error };
    default: return { tone: 'wait', text: 'Starting…' };
  }
}

function webcamBox(w) {
  const cf = w.cloudflare;
  const how = w.direct
    ? `Webcams connect <b>browser to browser</b> (needed for the public link). Everyone in the room can see each other's internet address, so only invite people you know. If someone's camera never appears, add a Cloudflare relay below.`
    : `Webcams go through <b>this PC's own relay</b>: nobody sees anyone else's internet address. This needs friends to reach your PC directly or through Tailscale; with the public link on, webcams switch to browser to browser by themselves.`;
  return `<div class="fix" style="margin-top:10px"><b>Webcams</b><p class="fine">${how}</p>
    <label class="field inline"><span>How webcams connect</span><select id="webcamMode">
      <option value="auto" ${w.mode === 'auto' ? 'selected' : ''}>Automatic (recommended)</option>
      <option value="relay" ${w.mode === 'relay' ? 'selected' : ''}>Only through this PC</option>
      <option value="direct" ${w.mode === 'direct' ? 'selected' : ''}>Always browser to browser</option></select></label>
    <details style="margin-top:6px"${cf && !cf.ok ? ' open' : ''}><summary class="fine">Cameras won't connect over the public link? Add a Cloudflare relay${cf ? (cf.ok ? ' (on)' : ' (not working)') : ''}</summary>
      <p class="fine">Some networks (phone carriers, apartment internet) block direct connections. A relay always works. Cloudflare's costs about $0.05 per GB (roughly 2 cents per hour for two cameras). In the Cloudflare dashboard open <b>Realtime → TURN Server</b>, create a key, and paste its ID and token here.</p>
      <div class="copy-row"><input id="cfKeyId" placeholder="TURN key ID" value="${esc(cf ? cf.keyId : '')}" spellcheck="false"><input id="cfToken" placeholder="API token" type="password" spellcheck="false"></div>
      <div class="row" style="margin-top:6px"><button class="btn sm primary" type="button" id="cfSave">Save relay</button>${cf ? '<button class="btn sm" type="button" id="cfRemove">Remove</button>' : ''}</div>
      ${cf && cf.error ? `<p class="fine bad">${esc(cf.error)}</p>` : cf && cf.ok ? '<p class="fine good">Relay is working.</p>' : ''}
    </details></div>`;
}

function tailscaleBox(t) {
  const f = t.funnel || {};
  let cert = '';
  if (t.trusted) cert = `<p class="fine good">Trusted certificate: friends see <b>no</b> "connection isn't private" warning on <code>${esc(t.name)}</code>.</p>`;
  else if (t.app && t.name) cert = `<div class="fix"><b>Remove the browser warning (one time):</b> in the Tailscale admin page open <b>DNS</b>, scroll to <b>HTTPS Certificates</b> and click <b>Enable HTTPS</b>. Then restart Watch Party. ${t.certError ? `<br><span class="fine">Tailscale says: ${esc(t.certError)}</span>` : ''}</div>`;
  else if (!t.app) cert = `<p class="fine">Tailscale is running (address ${esc(t.ip)}), but its command-line tool <code>tailscale.exe</code> wasn't found in <code>C:\\Program Files\\Tailscale</code>. Reinstall Tailscale from tailscale.com/download (the version from that page, not the Microsoft Store one) to get the trusted certificate and the public link.</p><p class="fine" style="font-size:11px;opacity:.7">${(t.searchNotes || []).map(esc).join('<br>')}</p>`;
  else if (!t.online) cert = `<div class="fix"><b>Tailscale isn't connected on this PC</b>, so there's no public link yet. Watch Party tried to connect it. ${t.loginUrl ? `<div class="row" style="margin-top:8px"><a class="btn sm primary" href="${esc(t.loginUrl)}" target="_blank" rel="noopener">Sign in to Tailscale</a></div>` : 'Open <b>Tailscale</b> (its icon is near the clock, bottom right; or Start menu → Tailscale) and click <b>Connect</b>, or <b>Log in</b> if it asks.'} Watch Party notices within about 15 seconds and switches the invite to the public link by itself.<br><span class="fine">Tailscale says: ${esc(t.statusError || 'not connected')}</span></div>`;
  else if (!t.name) cert = `<p class="fine">Tailscale's tool was found (<code>${esc(t.appPath || '')}</code>) but it didn't give this PC's name. ${esc(t.statusError || 'Is Tailscale signed in?')} Once that's fixed, restart Watch Party.</p>`;
  let funnel = '';
  if (t.app && t.name) {
    funnel = `<label class="switch-row" style="margin-top:8px"><span><b>Public link for anyone</b><small>Friends don't need Tailscale. Tailscale relays the traffic (TCP only): webcams won't work, and speed is limited by Tailscale, so a "Compress for streaming" copy works best. Needs "HTTPS Certificates" and "Funnel" enabled for your Tailscale account.</small></span><input type="checkbox" class="switch" id="publicLinkSwitch" ${f.wanted ? 'checked' : ''} ${f.busy ? 'disabled' : ''}></label>`;
    if (f.wanted && f.on) funnel += `<p class="fine good">Public link is on: <code>${esc(f.url)}</code></p>`;
    else if (f.wanted && f.error) funnel += `<div class="fix"><b>One more step:</b> ${esc(f.error)}${f.enableLink ? `<div class="row" style="margin-top:8px"><a class="btn sm primary" href="${esc(f.enableLink)}" target="_blank" rel="noopener">Allow public links in Tailscale</a></div><span class="fine">Sign in if asked and click <b>Enable</b>. Watch Party notices within about 15 seconds and switches the invite to the public link by itself.</span>` : ''}</div>`;
  }
  return `<div class="fix" style="margin-top:10px"><b>Tailscale</b>${cert}${funnel}</div>`;
}

function renderInvite() {
  const i = S.info;
  if (!i) return;
  const url = i.joinUrl;
  $('#inviteUrl').value = url || '';
  const n = i.network || {};
  const privatePlayer = i.server && !['starting', 'running'].includes(i.server.status);
  const searching = !privatePlayer && (n.status === 'searching' || n.status === 'idle');
  $('#inviteQr').innerHTML = i.qr || (privatePlayer ? 'Start the server in People to invite guests' : searching ? '<div class="spinner"></div>' : 'No public link yet');
  // no browser warning to explain when the link has a real certificate (public link, or Tailscale with HTTPS on)
  const trustedLink = () => { const tt = (S.info?.network || {}).tailscale; return !!(tt && ((tt.funnel && tt.funnel.inUse) || (tt.inUse && tt.trusted))); };
  $('#guestNote').hidden = !url || trustedLink();
  const st = $('#inviteStatus');
  const sum = netSummary(i);
  const t = n.tailscale;
  const kind = t && t.funnel && t.funnel.inUse ? 'public' : t && t.inUse ? 'tailscale' : 'direct';
  const kb = $('#inviteKind');
  if (kb) {
    kb.hidden = !url;
    kb.className = `invite-kind ${kind}`;
    kb.innerHTML = kind === 'public' ? '<b>Works for anyone, anywhere.</b> No app needed.'
      : kind === 'tailscale' ? `<b>Only for people with Tailscale.</b> Anyone else sees "site can't be reached".${t.funnel && t.funnel.wanted ? ' The public link isn\'t ready yet: see the Room tab.' : ' For a link anyone can open, turn on "Public link for anyone" in the Room tab.'}`
      : '';
    if (kind === 'direct') kb.hidden = true;
  }
  if (url) {
    const r = n.reachable === 'yes' ? ' Checked: the port is open.' : n.reachable === 'checking' ? ' Checking the link…' : '';
    st.innerHTML = `${esc(sum.tone === 'ok' ? sum.text : 'Link ready.')}${r} This link stops working when you close Watch Party. You get a new one each time you start it.`;
  } else if (searching) st.textContent = sum.text;
  else st.innerHTML = `${esc(sum.text)} <button class="btn sm" type="button" data-goto-net>How to fix</button>`;
  $('#copyInvite').disabled = !url;
  $('#lanLink').innerHTML = i.lanJoinUrl ? `Someone on your home Wi-Fi? They can use <code>${esc(i.lanJoinUrl)}</code>` : '';
}
let invitePoll = null;
let lastHandoff = { name: '', at: 0 };
let handoffTimer = 0;
function animateHandoff(name) {
  const d = $('#inviteDialog'), status = $('#handoffStatus');
  if (!isHost || !d.open || !name) return;
  const now = Date.now();
  if (lastHandoff.name === name && now - lastHandoff.at < 5000) return;
  lastHandoff = { name, at: now };
  status.textContent = `${name}'s device reached the room`;
  status.hidden = false;
  clearTimeout(handoffTimer);
  if (visuals.motion) {
    $('#inviteQr').animate([
      { transform: 'scale(1)', opacity: 1 },
      { transform: 'scale(.94)', opacity: .55, offset: .45 },
      { transform: 'scale(1)', opacity: 1 },
    ], { duration: 520, easing: 'cubic-bezier(.2,.8,.2,1)' });
    status.animate([
      { transform: 'translateY(8px)', opacity: 0 },
      { transform: 'translateY(0)', opacity: 1 },
    ], { duration: 260, easing: 'ease-out' });
  }
  handoffTimer = setTimeout(() => { status.hidden = true; }, 6000);
}
function openInvite() {
  const d = $('#inviteDialog');
  $('#handoffStatus').hidden = true;
  renderInvite();
  if (!d.open) d.showModal();
  refreshInfo();
  clearInterval(invitePoll);
  invitePoll = setInterval(() => { if (!d.open) return clearInterval(invitePoll); const n = S.info?.network; if (!S.info?.joinUrl || (n && (n.status === 'searching' || n.reachable === 'checking'))) refreshInfo(); }, 2000);
}
$('#inviteBtn').addEventListener('click', openInvite);
$('#emptyInvite').addEventListener('click', openInvite);
$('#copyInvite').addEventListener('click', async () => {
  const v = $('#inviteUrl').value;
  try { await navigator.clipboard.writeText(v); } catch { $('#inviteUrl').select(); document.execCommand('copy'); }
  $('#copyInvite').innerHTML = `${icon('copy')}Copied`;
  setTimeout(() => { $('#copyInvite').innerHTML = `${icon('copy')}Copy`; }, 1600);
});
$('#copyGuestMsg').addEventListener('click', async () => {
  const tt = (S.info?.network || {}).tailscale;
  const trusted = !!(tt && ((tt.funnel && tt.funnel.inUse) || (tt.inUse && tt.trusted)));
  const text = trusted ? `Join my movie night: ${S.info?.joinUrl || ''}\n\nJust open the link. Chrome works best.`
    : `Join my movie night: ${S.info?.joinUrl || ''}\n\nIt's streaming from my home PC, so your browser will say the connection "isn't private". That's expected. Click "Advanced", then "Continue" (Safari: "Show Details", then "visit this website"). Chrome works best.`;
  try { await navigator.clipboard.writeText(text); toast('Message copied. Paste it to your guests.', { timeout: 2500 }); } catch { prompt('Copy this message:', text); }
});
$('#inviteDialog').addEventListener('click', e => {
  if (e.target.closest('[data-goto-net]')) { $('#inviteDialog').close(); room.classList.remove('no-sidebar'); setTab('settings'); $('#netBox').scrollIntoView({ block: 'center' }); }
});

function renderSettings() {
  if (!isHost) return;
  const s = S.settings || {};
  for (const el of $$('[data-setting]')) el.checked = !!s[el.dataset.setting];
  for (const el of $$('[data-default]')) el.checked = !!(s.defaults && s.defaults[el.dataset.default]);
  const up = $('#uploadInput');
  if (S.info && document.activeElement !== up) up.value = S.info.uploadMbps || '';
  const mg = $('#maxGuestsInput');
  if (document.activeElement !== mg) mg.value = s.maxGuests || 8;
  $('#giphyKeyState').textContent = s.giphyKey ? 'Free GIF search enabled' : 'No key saved';
  const tmdbState = $('#tmdbTokenState');
  $('#wyzieKeyState').textContent = s.subtitlesConfigured ? 'Automatic lookup connected' : 'Not connected';
  if (tmdbState) tmdbState.textContent = S.info?.movieTv?.tmdbConfigured ? `TMDB connected · ${S.info?.movieTv?.sources || 0} authorized source${S.info?.movieTv?.sources === 1 ? '' : 's'}` : 'Optional · free catalog is active';
  const i = S.info;
  const box = $('#netBox');
  if (!i || !box) return;
  if (i.server && !['starting', 'running'].includes(i.server.status)) {
    box.innerHTML = '<p class="fine">Private player. Open People and choose Start server to enable guest links and connection settings.</p>';
    return;
  }
  const n = i.network || {};
  const sum = netSummary(i);
  const needsManual = !i.joinUrl && !['searching', 'idle'].includes(n.status);
  const ph = $('#publicHostInput');
  const focused = document.activeElement === ph;
  box.innerHTML = `
    <div class="net-line ${sum.tone}"><i></i><span>${esc(sum.text)}</span></div>
    ${sum.detail && !n.publicHost ? `<p class="fine">${esc(sum.detail)}</p>` : ''}
    ${i.joinUrl ? `<p class="fine">Friends connect to <code>${esc(i.joinUrl.split('/join/')[0])}</code>${n.reachable === 'yes' ? ' · port confirmed open' : ''}.</p>` : ''}
    ${needsManual ? `
      <div class="fix">
        <b>To fix it once, in your router's settings:</b>
        <ol>
          <li>Open your router's admin page (often <code>192.168.0.1</code> or <code>192.168.1.1</code>, or your provider's app, like Cox Panoramic WiFi).</li>
          <li>Either turn on <b>UPnP</b> and click <b>Try again</b> below, or add a <b>port forward</b>: port <b>${n.port}</b>, <b>TCP and UDP</b>, to this PC${n.localIp ? ` (<code>${esc(n.localIp)}</code>)` : ''}.</li>
          <li>Enter your public IP address below (your router's status page shows it).</li>
        </ol>
      </div>` : ''}
    ${n.status === 'cgnat' ? `<p class="fine">Your provider shares one internet address between customers, so direct connections can't reach you.</p>` : ''}
    ${needsManual || n.status === 'cgnat' ? `
      <div class="fix">
        <b>Apartment or student-housing internet (like Pavlov Media)?</b> Those networks usually block incoming connections, and the router isn't yours to change. Use <b>Tailscale</b> instead (free, private):
        <ol>
          <li>Install Tailscale on this PC from tailscale.com and sign in.</li>
          <li>In the Tailscale admin page, open <b>Machines</b>, click <b>…</b> next to this PC, choose <b>Share</b>, and send the share link to each friend.</li>
          <li>Each friend installs Tailscale, signs in, and accepts your share link (one time).</li>
          <li>Come back here: the invite link switches to your Tailscale address by itself.</li>
        </ol>
      </div>` : ''}
    ${n.tailscale && !n.tailscale.inUse && !(n.tailscale.funnel && n.tailscale.funnel.inUse) ? `<p class="fine">Tailscale is running on this PC. Friends you've shared this PC with can also use <code>${esc(n.tailscale.url)}</code></p>` : ''}
    ${n.tailscale ? tailscaleBox(n.tailscale) : ''}
    ${webcamBox(n.webcams || {})}
    <label class="field" style="margin-top:10px"><span>Public address ${n.status === 'mapped' ? '(detected automatically, leave empty)' : ''}</span>
      <span class="copy-row"><input id="publicHostInput" placeholder="${esc(n.externalIp && n.status === 'mapped' ? n.externalIp : 'e.g. 68.2.10.45')}" spellcheck="false"><button class="btn sm" type="button" id="lookupIp">Look up</button></span></label>
    <div class="row"><button class="btn sm" type="button" id="netRetry">${icon('refresh')}Try router again</button></div>
    ${(i.blocked || []).length ? `<div class="fix"><b>Blocked internet addresses (${i.blocked.length}):</b> ${i.blocked.map(b => `<code>${esc(b.ip)}</code>`).join(' ')}<br>These tried wrong links too many times and are blocked for an hour. <button class="btn sm" type="button" id="unblockAll">Unblock all</button></div>` : ''}
    <p class="fine">Webcam relay: ${n.webcamRelay ? `running on this PC (UDP ${n.udpExternal || n.port})` : 'not running'} · Encoder for "Compress for streaming": <b>${esc(i.encoderLabel || 'checking…')}</b></p>`;
  const ph2 = $('#publicHostInput');
  ph2.value = n.publicHost || '';
  if (focused) ph2.focus();
  ph2.addEventListener('change', async () => { S.info = await api('/api/settings', { method: 'POST', body: JSON.stringify({ publicHost: ph2.value }) }); renderSettings(); renderInvite(); });
  $('#lookupIp').addEventListener('click', async () => {
    try {
      const r = await api('/api/network/lookup-ip', { method: 'POST' });
      ph2.value = r.ip;
      S.info = await api('/api/settings', { method: 'POST', body: JSON.stringify({ publicHost: r.ip }) });
      renderSettings(); renderInvite();
    } catch (e) { toast(e.message, { kind: 'error', timeout: 6000 }); }
  });
  const wm = $('#webcamMode');
  if (wm) wm.addEventListener('change', async () => { S.info = await api('/api/settings', { method: 'POST', body: JSON.stringify({ webcamMode: wm.value }) }); renderSettings(); });
  const cfs = $('#cfSave');
  if (cfs) cfs.addEventListener('click', async () => {
    const keyId = $('#cfKeyId').value.trim(), token = $('#cfToken').value.trim();
    if (!keyId || !token) { toast('Paste both the key ID and the token.', { timeout: 3000 }); return; }
    cfs.disabled = true;
    S.info = await api('/api/settings', { method: 'POST', body: JSON.stringify({ cloudflareTurn: { keyId, token } }) }).catch(e => { toast(e.message, { kind: 'error' }); return S.info; });
    renderSettings();
  });
  const cfr = $('#cfRemove');
  if (cfr) cfr.addEventListener('click', async () => { S.info = await api('/api/settings', { method: 'POST', body: JSON.stringify({ cloudflareTurn: null }) }); renderSettings(); });
  const pl = $('#publicLinkSwitch');
  if (pl) pl.addEventListener('change', async () => {
    pl.disabled = true;
    toast(pl.checked ? 'Asking Tailscale for a public link…' : 'Turning the public link off…', { timeout: 4000 });
    try { S.info = await api('/api/settings', { method: 'POST', body: JSON.stringify({ publicLink: pl.checked }) }); } catch (e) { toast(e.message, { kind: 'error', timeout: 6000 }); }
    renderSettings(); renderInvite();
  });
  const ub = $('#unblockAll');
  if (ub) ub.addEventListener('click', async () => { S.info = await api('/api/unblock', { method: 'POST', body: '{}' }); renderSettings(); });
  $('#netRetry').addEventListener('click', async () => { await api('/api/network/retry', { method: 'POST' }); toast('Asking the router again…', { timeout: 2000 }); setTimeout(refreshInfo, 500); });
}
for (const el of $$('[data-setting]')) el.addEventListener('change', () => conn.send({ type: 'settings', settings: { [el.dataset.setting]: el.checked } }));
for (const el of $$('[data-default]')) el.addEventListener('change', () => conn.send({ type: 'settings', settings: { defaults: { [el.dataset.default]: el.checked } } }));
$('#maxGuestsInput').addEventListener('change', e => conn.send({ type: 'settings', settings: { maxGuests: +e.target.value || 8 } }));
$('#uploadInput').addEventListener('change', async e => { S.info = await api('/api/settings', { method: 'POST', body: JSON.stringify({ uploadMbps: +e.target.value || 0 }) }); renderLibrary(); });
$('#giphyKeySave').addEventListener('click', async () => {
  const button = $('#giphyKeySave'), input = $('#giphyKey'); button.disabled = true;
  try { S.info = await api('/api/settings', { method: 'POST', body: JSON.stringify({ giphyKey: input.value.trim() }) }); S.settings = S.info.settings || S.settings; input.value = ''; renderSettings(); toast(S.settings.giphyKey ? 'Free GIF search enabled.' : 'GIF key removed.'); }
  catch (error) { toast(error.message, { kind: 'error' }); }
  finally { button.disabled = false; }
});
$('#tmdbTokenSave').addEventListener('click', async () => {
  const button = $('#tmdbTokenSave'), input = $('#tmdbToken');
  const token = input.value.trim();
  if (!token && S.info?.movieTv?.tmdbConfigured && !confirm('Remove the saved TMDB token?')) return;
  button.disabled = true;
  try {
    S.info = await api('/api/settings', { method: 'POST', body: JSON.stringify({ tmdbToken: token }) });
    S.settings = S.info.settings || S.settings;
    input.value = '';
    toast(token ? 'TMDB catalog connected.' : 'TMDB token removed.', { timeout: 2500 });
    renderSettings();
  } catch (e) { toast(e.message, { kind: 'error', timeout: 5000 }); }
  finally { button.disabled = false; }
});
$('#wyzieKeySave').addEventListener('click', async () => {
  const button = $('#wyzieKeySave'), input = $('#wyzieKey');
  button.disabled = true;
  try {
    S.info = await api('/api/settings', { method: 'POST', body: JSON.stringify({ wyzieKey: input.value.trim() }) });
    S.settings = S.info.settings || S.settings;
    input.value = '';
    renderSettings();
    maybeFindSubtitles();
    toast(S.settings.subtitlesConfigured ? 'Automatic subtitle lookup enabled.' : 'Subtitle key removed.');
  } catch (error) { toast(error.message, { kind: 'error' }); }
  finally { button.disabled = false; }
});
$('#rotateBtn').addEventListener('click', () => { if (confirm('Make a new invite link? Everyone currently watching will be disconnected and will need the new link.')) conn.send({ type: 'rotate-link' }); });

let libTimer = null;
function loadLibrarySoon() { clearTimeout(libTimer); libTimer = setTimeout(loadLibrary, 250); }
async function loadLibrary() {
  if (!isHost) { conn.send({ type: 'lib-list' }); return; } // the sanitized answer arrives as 'library'
  try { S.library = await api('/api/library'); } catch (e) { return; }
  const ta = $('#foldersInput');
  if (document.activeElement !== ta) ta.value = (S.library.folders || []).join('\n');
  $('#foldersSummary').textContent = S.library.folders.length ? `Movie folders (${S.library.folders.length})` : 'Add your movie folders';
  if (!S.library.folders.length) $('#foldersBox').open = true;
  renderLibrary();
}

function guestCount() { return Math.max(1, S.people.filter(p => p.admitted && p.role !== 'host').length); }
function nativeHlsViewerHere() { return S.people.some(p => p.admitted && p.status?.hls); }

// A one-line explanation from the server becomes a short tag; the full text opens on click.
function reasonLine(text) {
  let m;
  if (/profile 5/.test(text)) return { label: 'Dolby Vision Profile 5', why: 'A fancy HDR format most browsers show as a black screen. Preparing the file re-encodes it so the picture comes back.' };
  if (/Dolby Vision/.test(text)) return { label: 'Dolby Vision', why: 'A newer HDR format browsers can\'t play directly. Preparing the file converts it so everyone sees the picture.' };
  if ((m = /^(\w+) files /.exec(text))) return { label: `${m[1]} container`, why: `.${m[1].toLowerCase()} files aren\'t supported by browsers for streaming. One quick repackage into .mp4 fixes it (no quality loss).` };
  if ((m = /^(.+?) audio /.exec(text))) return { label: `${m[1].split(' ')[0]} audio`, why: 'The audio format in this file (DTS / TrueHD / AC-3 / …) isn\'t supported by browsers. Preparing will convert it to AAC without changing the picture.' };
  if (/re-encoded/.test(text)) return { label: 'Format needs re-encoding', why: 'The video has to be re-encoded before browsers can play it.' };
  if (/hev1/.test(text)) return { label: 'Apple-incompatible HEVC', why: 'This HEVC file uses a stream tag Apple devices skip. Preparing re-tags it so iPhone, iPad and Safari can play it.' };
  if (/No video track/.test(text)) return { label: 'No video track', why: 'This file contains no video inside, only audio or metadata.' };
  return { label: 'Needs preparing', why: text };
}
function aggregatedPrepTag(reasons, blocking) {
  const lines = reasons.map(reasonLine);
  return {
    tag: 'Needs preparing',
    bad: !!blocking,
    text: 'This file needs a quick preparation before it can stream to browsers.',
    reasons: lines,
  };
}
const whyPop = Object.assign(document.createElement('div'), { className: 'why-pop', hidden: true });
whyPop.setAttribute('role', 'dialog');
document.body.appendChild(whyPop);
function closeWhy() { whyPop.hidden = true; whyPop.anchor = null; }
document.addEventListener('click', e => {
  const tag = e.target.closest('[data-why]');
  if (!tag) { if (!whyPop.contains(e.target)) closeWhy(); return; }
  e.stopPropagation();
  if (whyPop.anchor === tag && !whyPop.hidden) return closeWhy();
  let reasons = null;
  try { reasons = JSON.parse(tag.dataset.whyJson || 'null'); } catch {}
  if (Array.isArray(reasons) && reasons.length) {
    const intro = tag.dataset.why || '';
    const bullets = reasons.map(r => `<li><b>${esc(r.label)}</b><span>${esc(r.why)}</span></li>`).join('');
    whyPop.innerHTML = `${intro ? `<p>${esc(intro)}</p>` : ''}<ul class="why-list">${bullets}</ul>`;
  } else {
    whyPop.textContent = tag.dataset.why;
  }
  whyPop.anchor = tag;
  whyPop.hidden = false;
  const r = tag.getBoundingClientRect(), w = Math.min(320, innerWidth - 24);
  whyPop.style.width = w + 'px';
  whyPop.style.left = Math.max(12, Math.min(r.left, innerWidth - w - 12)) + 'px';
  const below = r.bottom + 6, h = whyPop.offsetHeight;
  whyPop.style.top = (below + h > innerHeight - 8 ? Math.max(8, r.top - h - 6) : below) + 'px';
}, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !whyPop.hidden) closeWhy(); });
document.addEventListener('scroll', closeWhy, true);

function movieChips(it) {
  const i = it.info;
  if (!i) return '';
  const c = [];
  const v = i.video || {};
  const r = resLabel(v.width, v.height);
  if (r) c.push(`<span class="chip">${r}</span>`);
  if (v.hdr) c.push(`<span class="chip hdr">HDR</span>`);
  if (i.duration) c.push(`<span class="chip">${fmtTime(i.duration)}</span>`);
  c.push(`<span class="chip">${esc(it.sizeLabel)}</span>`);
  return c.join('');
}

function prepFormHtml(it) {
  const i = it.info;
  const o = S.prepOpts.get(it.id) || {};
  const must = i.plan.mode === 'transcode';
  const audioOpts = i.audios.map(a => `<option value="${a.index}" ${String(o.audioIndex ?? i.defaultAudioIndex) === String(a.index) ? 'selected' : ''}>${esc([a.lang, a.label, a.title].filter(Boolean).join(' · '))}</option>`).join('');
  const compress = !!o.compress;
  const hls = o.hls !== false;
  const appleHere = nativeHlsViewerHere();
  const target = o.targetMbps || (i.video.width > 1920 ? 25 : 12);
  const textSubs = i.subs.filter(s => s.text).length;
  const imgSubs = i.subs.filter(s => !s.text).length;
  const quality = compress ? (target >= 25 ? 'high' : target >= 16 ? 'standard' : 'light') : 'original';
  const qualityNote = {
    original: must ? 'Shown exactly as it is on your disk. No re-encoding.' : 'Shown exactly as it is on your disk.',
    light:    'Smallest file. Best when friends have slow internet.',
    standard: 'Great balance of quality and speed. Recommended.',
    high:     'Looks closest to the original. Needs faster internet.',
  };
  return `<div class="prep-form" data-form="${it.id}">
    ${i.audios.length > 1 ? `<label class="opt">Audio language<select data-o="audioIndex">${audioOpts}</select></label>` : ''}
    ${(() => { const a = i.audios.find(x => String(x.index) === String(o.audioIndex ?? i.defaultAudioIndex)) || i.audios[0]; return a && a.channels > 2; })() ? `<div class="opt"><div class="seg">
      <label><input type="radio" name="am-${it.id}" data-o="audioMode" value="surround" ${o.audioMode !== 'stereo' ? 'checked' : ''}>Surround sound</label>
      <label><input type="radio" name="am-${it.id}" data-o="audioMode" value="stereo" ${o.audioMode === 'stereo' ? 'checked' : ''}>Stereo</label></div></div>` : ''}
    <div class="opt"><div class="opt-title">Picture quality</div><div class="seg quality-seg">
      <label><input type="radio" name="vm-${it.id}" data-o="quality" value="original" ${quality === 'original' ? 'checked' : ''}>Original</label>
      <label><input type="radio" name="vm-${it.id}" data-o="quality" value="light" ${quality === 'light' ? 'checked' : ''}>Light</label>
      <label><input type="radio" name="vm-${it.id}" data-o="quality" value="standard" ${quality === 'standard' ? 'checked' : ''}>Standard</label>
      <label><input type="radio" name="vm-${it.id}" data-o="quality" value="high" ${quality === 'high' ? 'checked' : ''}>High</label></div>
      <div class="hint" style="margin-top:6px">${qualityNote[quality]}</div></div>
    <label class="check-row"><input type="checkbox" data-o="hls" ${hls ? 'checked' : ''}><span><b>Start sooner for everyone</b>${appleHere ? ' · a phone or tablet is here' : ''}<br>Everyone can begin watching after the opening is ready, instead of waiting for the whole file.</span></label>
    <div class="hint">${textSubs ? `${textSubs} subtitle track${textSubs > 1 ? 's' : ''} will be included.` : 'No subtitles found in this file.'}${imgSubs ? ` ${imgSubs} picture-based subtitle track${imgSubs > 1 ? 's' : ''} can't be shown in browsers.` : ''}</div>
    <div class="hint">The prepared copy is cleaned up when Watch Party closes, so it doesn't fill your disk.</div>
    <div class="row end" style="margin-top:0"><button class="btn sm" data-act="closeprep" data-id="${it.id}">Cancel</button><button class="btn sm primary" data-act="prepare" data-id="${it.id}">Start</button></div>
  </div>`;
}

function renderLibrary() {
  const list = $('#libList');
  const L = S.library;
  if (!L) return setHtml(list, '<div class="empty-lib"><div class="spinner"></div></div>');
  if (!L.folders.length) return setHtml(list, `<div class="empty-lib">${isHost ? 'Add the folder where your movie files are, and they\'ll show up here.' : 'The host hasn\'t added any movies yet.'}</div>`);
  const q = $('#libSearch').value.trim().toLowerCase();
  const items = L.items.filter(it => !q || it.title.toLowerCase().includes(q) || it.rel.toLowerCase().includes(q));
  if (!items.length) return setHtml(list, `<div class="empty-lib">${L.scanning ? 'Scanning your folders…' : q ? 'No matches.' : 'No movie files found in those folders (.mkv, .mp4, .m2ts…).'}</div>`);
  const upload = S.info?.uploadMbps || 0;
  const viewers = guestCount();
  setHtml(list, items.map(it => {
    const i = it.info;
    const current = S.movie && S.movie.id === it.id;
    let status = '', acts = '';
    const tags = []; // short labels (MKV, Dolby Vision…) whose explanation opens on click
    if (it.job && ['queued', 'running'].includes(it.job.state)) {
      const ready = !!(it.job.ready && it.playable);
      status = `<div class="progress ${ready ? 'ready' : ''}"><div style="width:${it.job.percent.toFixed(1)}%"></div></div>
        <div class="progress-meta"><span>${ready ? 'Ready to watch · still preparing in background' : `${esc(it.job.label)}${it.job.state === 'queued' ? ' · queued' : ''}`}</span><span data-pm>${it.job.percent.toFixed(0)}%${it.job.speed ? ` · ${it.job.speed.toFixed(1)}×` : ''}${it.job.eta ? ` · ${fmtEta(it.job.eta)}` : ''}</span></div>`;
      if (ready) {
        acts = current
          ? `<span class="chip ok">Now showing</span><button class="btn sm" data-act="unload">Stop showing</button>`
          : `<button class="btn sm primary" data-act="play" data-id="${it.id}">${icon('play')}Show in room</button>`;
        acts += `<button class="btn sm" data-act="cancel" data-id="${it.id}">Stop background preparation</button>`;
      } else acts = `<button class="btn sm" data-act="cancel" data-id="${it.id}">Cancel</button>`;
    } else if (it.job && it.job.state === 'error') {
      status = `<div class="warnline bad">Prepare failed: ${esc(it.job.error)}</div>`;
    } else if (it.job && it.job.state === 'done') {
      status = `<div class="warnline good">Ready to play.</div>`;
    }
    if (!i && !it.probeError) {
      status = status || '<div class="fine">Reading file info…</div>';
    } else if (it.probeError) {
      status = `<div class="warnline bad">Couldn't read this file: ${esc(it.probeError)}</div>`;
      acts = `<button class="btn sm" data-act="probe" data-id="${it.id}">Try again</button>`;
    } else if (!it.job || !['queued', 'running'].includes(it.job.state)) {
      const plan = i.plan;
      if (it.playable) {
        acts = current
          ? `<span class="chip ok">Now showing</span><button class="btn sm" data-act="unload">Stop showing</button>`
          : `<button class="btn sm primary" data-act="play" data-id="${it.id}">${icon('play')}Show in room</button>`;
        if (!S.prepOpen.has(it.id)) acts += `<button class="btn sm ghost" data-act="openprep" data-id="${it.id}">Options</button>`;
        if (isHost && it.prepared && it.prepared.mode !== 'subs' && !current) acts += `<button class="btn sm ghost" data-act="unprep" data-id="${it.id}" title="Delete the prepared copy to free up ${esc(it.prepared.sizeLabel)}">Delete copy</button>`;
        if (it.prepared && it.prepared.mode !== 'subs') status = status || (it.prepared.mode === 'hls'
          ? `<div class="fine">Ready for every device · ${esc(it.prepared.sizeLabel)}</div>`
          : `<div class="fine">Ready to play · ${esc(it.prepared.sizeLabel)}${it.prepared.compressed ? ' · smaller for streaming' : ''}</div>`);
      } else if (plan.mode === 'unsupported') {
        if (plan.reasons.length) tags.push(aggregatedPrepTag(plan.reasons, true));
      } else {
        if (it.stalePrepared) tags.push({ tag: 'Old copy', bad: true, text: 'The copy made by an older version can show a black screen. Prepare it again to fix it; the old copy will be replaced.' });
        if (plan.reasons.length) tags.push(aggregatedPrepTag(plan.reasons, false));
        const est = plan.mode === 'remux' ? ` (~${Math.max(1, Math.round(it.size / 120e6 / 60))} min)` : '';
        if (!S.prepOpen.has(it.id)) acts = `<button class="btn sm primary" data-act="quickprep" data-id="${it.id}">Prepare${est}</button><button class="btn sm ghost" data-act="openprep" data-id="${it.id}">Options</button>`;
      }
      const mbps = (it.prepared && it.prepared.bitrateMbps) || i.bitrateMbps;
      if (upload && mbps && mbps * viewers > upload * 0.85) {
        tags.push({ tag: 'Too big for your internet', bad: true, text: `This movie file is bigger than your internet can send out comfortably to ${viewers} viewer${viewers > 1 ? 's' : ''}. Open Options and pick a lower picture quality for smoother playback.` });
      }
      if (i.plan.mode === 'direct' && !it.prepared) {
        const ts = i.subs.filter(s => s.text).length;
        if (ts) status = status || `<div class="fine">Includes ${ts} subtitle track${ts > 1 ? 's' : ''}. Open Options to turn them on.</div>`;
      }
    }
    return `<div class="movie ${current ? 'current' : ''}" data-movie="${it.id}">
      <div class="movie-top"><div style="min-width:0;flex:1"><div class="mt">${esc(it.title)}</div><div class="mf" title="${esc(it.rel)}">${esc(it.rel)}</div></div></div>
      <div class="chips">${movieChips(it)}${tags.map(t => `<button type="button" class="chip why-tag ${t.bad ? 'bad' : 'warn'}" data-why="${esc(t.text)}" data-why-json="${esc(JSON.stringify(t.reasons || null))}" title="What does this mean?">${esc(t.tag)}${t.reasons?.length > 1 ? ` <span class="chip-count">${t.reasons.length}</span>` : ''}</button>`).join('')}</div>
      ${status}
      ${acts ? `<div class="acts">${acts}</div>` : ''}
      ${S.prepOpen.has(it.id) && i ? prepFormHtml(it) : ''}
    </div>`;
  }).join(''));
}

function renderLibraryCurrent() { if (S.library) renderLibrary(); }

function updateJob(id, job) {
  const it = S.library && S.library.items.find(x => x.id === id);
  if (it) {
    const readinessChanged = !!it.job?.ready !== !!job.ready;
    it.job = job;
    if (readinessChanged) { renderLibrary(); return; }
  }
  const card = document.querySelector(`[data-movie="${id}"]`);
  const bar = card && card.querySelector('.progress > div');
  if (bar) {
    $('#libList')._html = null; // edited in place below, so the next full render must not be skipped
    bar.style.width = job.percent.toFixed(1) + '%';
    bar.parentElement.classList.toggle('ready', !!job.ready);
    const pm = card.querySelector('[data-pm]');
    if (pm) pm.textContent = job.ready
      ? 'Available now'
      : `${job.percent.toFixed(0)}%${job.speed ? ` · ${job.speed.toFixed(1)}×` : ''}${job.eta ? ` · ${fmtEta(job.eta)}` : ''}`;
    const meta = bar.parentElement.nextElementSibling;
    if (meta) meta.firstElementChild.textContent = job.ready ? 'Ready to watch · still preparing in background' : (job.label || 'Preparing') + (job.state === 'queued' ? ' · queued' : '');
  } else renderLibrary();
}

$('#libSearch').addEventListener('input', renderLibrary);
$('#libRescan').addEventListener('click', async () => { await api('/api/library/rescan', { method: 'POST' }); toast('Rescanning folders…', { timeout: 1500 }); });
$('#foldersSave').addEventListener('click', async () => {
  const folders = $('#foldersInput').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  try {
    const r = await api('/api/library/folders', { method: 'POST', body: JSON.stringify({ folders }) });
    if (r.missing && r.missing.length) toast(`Couldn't find: ${r.missing.join(', ')}`, { kind: 'error', timeout: 6000 });
    else { toast('Folders saved', { timeout: 1500 }); $('#foldersBox').open = false; }
    loadLibrary();
  } catch (e) { toast(e.message, { kind: 'error' }); }
});
const QUALITY_MBPS = { original: 0, light: 8, standard: 16, high: 25 };
$('#libList').addEventListener('change', e => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  const id = form.dataset.form;
  const o = S.prepOpts.get(id) || {};
  const k = e.target.dataset.o;
  if (k === 'quality') {
    const q = e.target.value;
    o.compress = q !== 'original';
    o.targetMbps = QUALITY_MBPS[q] || 0;
  }
  else if (k === 'hls') o.hls = e.target.checked;
  else if (k === 'audioIndex' || k === 'targetMbps') o[k] = +e.target.value;
  else if (k) o[k] = e.target.value;
  S.prepOpts.set(id, o);
  renderLibrary();
});
$('#libList').addEventListener('click', async e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const id = b.dataset.id;
  try {
    switch (b.dataset.act) {
      case 'play': conn.send({ type: 'select-movie', id }); break;
      case 'unload': conn.send({ type: 'select-movie', id: null }); break;
      case 'openprep': S.prepOpen.add(id); renderLibrary(); break;
      case 'closeprep': S.prepOpen.delete(id); renderLibrary(); break;
      case 'quickprep': {
        const opts = { hls: true };
        if (!isHost) { conn.send({ type: 'lib-prepare', id, opts }); break; }
        await api(`/api/prepare/${id}`, { method: 'POST', body: JSON.stringify(opts) });
        break;
      }
      case 'prepare': {
        const o = { hls: true, ...(S.prepOpts.get(id) || {}) };
        const it = S.library.items.find(x => x.id === id);
        if (o.compress && !o.targetMbps) o.targetMbps = it.info.video.width > 1920 ? 25 : 12;
        if (isHost) await api(`/api/prepare/${id}`, { method: 'POST', body: JSON.stringify(o) });
        else conn.send({ type: 'lib-prepare', id, opts: o });
        S.prepOpen.delete(id);
        break;
      }
      case 'cancel': if (!isHost) { conn.send({ type: 'lib-cancel', id }); break; } await api(`/api/cancel/${id}`, { method: 'POST' }); break;
      case 'unprep': if (!isHost) break; if (confirm('Delete the prepared copy? You can prepare it again later.')) await api(`/api/prepared/${id}`, { method: 'DELETE' }); break;
      case 'probe': if (!isHost) { conn.send({ type: 'lib-probe', id }); break; } await api(`/api/probe/${id}`, { method: 'POST' }); break;
      default:
    }
  } catch (err) { toast(err.message, { kind: 'error', timeout: 6000 }); }
  loadLibrarySoon();
});

$('#streamGo').addEventListener('click', () => {
  const url = $('#streamUrl').value.trim();
  if (!url) return toast('Paste the link of a movie or episode first.', { timeout: 2500 });
  conn.send({ type: 'select-url', url, inTabs: $('#streamInTabs').checked });
  $('#streamUrl').value = '';
});
$('#streamUrl').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#streamGo').click(); } });

$('#customGo').addEventListener('click', () => {
  if (!isHost) return;
  let url = $('#customUrl').value.trim();
  if (!url) return toast('Paste the link of the page with the video first.', { timeout: 2500 });
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  conn.send({ type: 'select-url', url, custom: true, strict: $('#customStrict').checked });
  $('#customUrl').value = '';
  setTab('chat');
  // straight into the Watch Party window (without the extension, the panel shows how to add it)
  if (remote && remote.present && !extOutdated(remote.version) && !isTheater) enterTheater();
});
{
  const cb = $('#customStrict');
  cb.checked = store.get('wp.customStrict', true);
  cb.addEventListener('change', () => store.set('wp.customStrict', cb.checked));
}
$('#customUrl').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#customGo').click(); } });

export { animateHandoff, loadLibrary, loadLibrarySoon, openInvite, refreshInfo, refreshInfoSoon, renderLibrary, renderLibraryCurrent, renderSettings, updateJob };
