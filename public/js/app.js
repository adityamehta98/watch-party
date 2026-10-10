import { Connection } from './net.js';
import { SyncPlayer, DEVICE } from './player.js';
import { PLATFORM, installTarget } from './platform.js';
import { playbackCapabilities, deliverySources } from './capabilities.js';
import { observeVisualPolicy, visualPolicy } from './visuals.js';
import { Mesh } from './rtc.js';
import { YouTubeMedia, RemoteMedia, SERVICE_NAMES, SERVICE_HOMES, SERVICE_COLORS, serviceOfUrl, extOutdated, canonicalUrl, isTitlePage } from './media.js';

// ---------------------------------------------------------------- helpers
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const icon = (name, cls = '') => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
function fmtTime(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function fmtDur(t) { if (t < 60) return `${Math.round(t)}s`; const h = Math.floor(t / 3600), m = Math.round((t % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m`; }
function fmtEta(s) { if (s == null) return ''; if (s < 60) return `${s}s left`; const m = Math.round(s / 60); return m < 60 ? `${m} min left` : `${Math.floor(m / 60)}h ${m % 60}m left`; }
function hue(str) { let h = 0; for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
const avatar = (name, cls = 'av') => `<span class="${cls}" style="background:hsl(${hue(name)} 70% 68%)">${esc((name || '?').trim().charAt(0).toUpperCase())}</span>`;
function randId() { const a = new Uint8Array(12); crypto.getRandomValues(a); return [...a].map(b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join(''); }
function resLabel(w, h) { if (!w) return ''; if (w >= 3200 || h >= 1800) return '4K'; if (w >= 1800 || h >= 1000) return '1080p'; if (w >= 1200 || h >= 700) return '720p'; return `${h}p`; }
function codecLabel(c) { return ({ hevc: 'HEVC', h264: 'H.264', av1: 'AV1', vp9: 'VP9', mpeg2video: 'MPEG-2', vc1: 'VC-1' })[c] || (c || '').toUpperCase(); }

// ---------------------------------------------------------------- boot
const app = $('#app');
const parts = location.pathname.split('/').filter(Boolean);
const mode = parts[0] === 'host' ? 'host' : parts[0] === 'join' ? 'guest' : null;
const key = parts[1] || '';
const isHost = mode === 'host';
if (isHost) app.classList.add('is-host');

// "Watch here" window (the extension shows this page next to Netflix / Prime Video / ...).
// It hands over who you are, so you stay the same person in the room (no new name, no new approval).
const isTheater = new URLSearchParams(location.search).get('theater') === '1' && window.top !== window;
const handoff = new URLSearchParams(location.hash.slice(1));
if (location.hash) history.replaceState(null, '', location.pathname + location.search);
if (isTheater) app.classList.add('theater');
if (isTheater && /^[a-z0-9]{8,40}$/.test(handoff.get('wpcid') || '')) store.set(isHost ? 'wp.hostId' : 'wp.clientId', handoff.get('wpcid'));
if (isTheater && handoff.get('wpname')) store.set(isHost ? 'wp.hostName' : 'wp.name', handoff.get('wpname').slice(0, 32));
let clientId = store.get(isHost ? 'wp.hostId' : 'wp.clientId', null);
if (!clientId) { clientId = randId(); store.set(isHost ? 'wp.hostId' : 'wp.clientId', clientId); }

const S = {
  chatLog: [],
  me: null, perms: {}, people: [], totalMbps: 0, movie: null, state: null, settings: {}, reactions: [],
  observatory: null, bookmarks: [],
  peers: new Map(), remoteStreams: new Map(), cam: false, mic: false, tab: 'chat', unread: 0,
  library: null, info: null, prepOpen: new Set(), prepOpts: new Map(), lastSender: null, lastSenderTs: 0,
  name: '',
};

const video = $('#video');
const PLAYBACK = playbackCapabilities(video);
const stage = $('#stage');
// The media everything talks to: the <video> for your files, or a YouTube / streaming-tab adapter.
let M = video;
let ytMedia = null, remote = null;
let pipWin = null; // pop-out camera window
const room = $('#room');
let conn = null, player = null, mesh = null;

// Installable shell: room HTML, invite URLs, media and messages always stay network-only.
const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const installBtn = $('#installBtn');
let installPrompt = null;
if (!isTheater && !standalone && PLATFORM.appleMobile && PLATFORM.safari) installBtn.hidden = false;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; if (!isTheater && !standalone) installBtn.hidden = false; });
window.addEventListener('appinstalled', () => { installPrompt = null; installBtn.hidden = true; });
installBtn.addEventListener('click', async () => {
  if (installPrompt) { installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; installBtn.hidden = true; }
  else toast('In Safari, tap Share, then Add to Home Screen.', { timeout: 6000 });
});
if (!isTheater && 'serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});

function screen(name) { app.dataset.screen = name; }

function showDenied(title, text) {
  $('#deniedTitle').textContent = title;
  $('#deniedText').textContent = text;
  screen('denied');
}

if (!mode || !key) {
  showDenied('You need an invite link', 'Ask the host to send you the full watch party link.');
} else if (isHost) {
  start(store.get('wp.hostName', 'Host'));
} else if (isTheater && store.get('wp.name', '')) {
  start(store.get('wp.name', ''));
} else {
  const nameInput = $('#joinName');
  nameInput.value = store.get('wp.name', '');
  screen('join');
  setTimeout(() => nameInput.focus(), 50);
  $('#joinForm').addEventListener('submit', e => {
    e.preventDefault();
    const name = nameInput.value.trim().slice(0, 32);
    if (!name) return;
    store.set('wp.name', name);
    // this click lets the browser play sound later
    video.muted = false;
    try { video.play().catch(() => {}); } catch {}
    start(name);
  });
}

// ---------------------------------------------------------------- connection
function start(name) {
  S.name = name;
  screen('loading');
  conn = new Connection(key, () => ({ type: 'hello', clientId, name: S.name, capabilities: PLAYBACK }));
  mesh = new Mesh({
    send: m => conn.send(m),
    onRemoteStream: (id, stream) => { S.remoteStreams.set(id, stream); renderCams(); },
    onPeerGone: id => { S.remoteStreams.delete(id); renderCams(); },
  });
  ytMedia = new YouTubeMedia($('#ytHost'));
  remote = new RemoteMedia({ onInfo: () => {
    renderServicePanel(); maybeSendMeta();
    if (remote.present && extOutdated(remote.version) && !S.extWarned) {
      S.extWarned = true;
      const fix = remote.platform === 'safari'
        ? 'Update its containing app, make sure it is enabled in Safari Settings, then reload this page.'
        : `Open ${/Edg\//.test(navigator.userAgent) ? 'edge' : 'brave or chrome'}://extensions and click its reload arrow, then reload this page.`;
      toast(`Your Watch Party Sync extension is out of date (${remote.version || '?'}). ${fix}`, { kind: 'error', timeout: 20000 });
    }
  } });
  remote.onProblem = p => { if (p.kind === 'theater') clearTimeout(enterTheater.timer); extProblem(p); };
  remote.onUser = onRemoteUserAction;
  // the level set in Netflix & co's own player shows on the party's slider too (and is remembered)
  remote.onUserVolume = (v, muted) => { if (M !== remote) return; $('#volume').value = muted ? 0 : v; store.set('wp.volume', v); scheduleUi(); dockPushSoon(); };
  remote.onDock = onDockMessage;
  player = new SyncPlayer({
    video, clock: conn.clock,
    onStatus: st => conn.send({ type: 'status', status: st }),
    onBlocked: kind => { $('#unmutePill').hidden = false; if (kind === 'blocked') renderNotice(); },
    onChange: () => scheduleUi(),
  });
  wire();
  conn.connect();
}

function wire() {
  conn.on('status', s => {
    const pill = $('#connPill');
    pill.classList.toggle('ok', s === 'open');
    pill.classList.toggle('bad', s === 'reconnecting');
    pill.querySelector('b').textContent = s === 'open' ? 'Connected' : s === 'reconnecting' ? 'Reconnecting…' : 'Connecting…';
  });
  conn.on('clock', c => { if (c.rtt != null) $('#connPill').title = `Connected · ${Math.round(c.rtt)} ms round trip`; });
  conn.on('pending', () => screen('pending'));
  conn.on('denied', m => {
    const map = {
      removed: ['You were removed', 'The host removed you from this watch party.'],
      locked: ['This room is locked', 'The host isn\'t letting new people in right now.'],
      declined: ['The host didn\'t let you in', 'Ask them to try again.'],
      'link-changed': ['This link was replaced', 'The host made a new invite link. Ask them for it.'],
      full: ['The party is full', 'The host has reached the guest limit.'],
    };
    const [t, d] = map[m.reason] || ['You can\'t join', 'Ask the host for a new link.'];
    showDenied(t, d);
    teardownMedia();
  });
  conn.on('fatal', code => {
    if (app.dataset.screen === 'denied') return;
    if (code === 4000) showDenied('Opened somewhere else', 'This watch party is open in another tab or window. Use that one, or reload here to move it back.');
    else if (code === 4004) showDenied('This link doesn\'t work anymore', 'The host may have restarted the app or made a new link. Ask them for the latest one.');
    else showDenied('Disconnected', 'Reload the page to try again.');
    teardownMedia();
  });
  conn.on('welcome', onWelcome);
  conn.on('state', m => {
    const prev = S.state;
    S.serverState = m.state;
    if (staleOwnEcho(m)) return; // a newer skip / play / pause of ours is already on its way
    S.state = m.state;
    player.setState(m.state);
    renderNotice();
    scheduleUi();
    if (m.by && m.by !== S.me?.name && prev && ['play', 'pause', 'seek'].includes(m.action)) {
      const verb = { play: 'pressed play', pause: 'paused', seek: `jumped to ${fmtTime(m.state.position)}` }[m.action];
      toast(`${m.by} ${verb}`, { timeout: 2200 });
    }
  });
  conn.on('movie', m => loadMovie(m.movie));
  conn.on('people', m => { S.people = m.people; S.totalMbps = m.totalMbps || 0; S.observatory = m.observatory || null; renderPeople(); renderObservatory(); renderNowPlaying(); renderCams(); renderNotice(); });
  conn.on('chat', m => addChat(m.message, true));
  conn.on('react', scheduleReaction);
  conn.on('bookmarks', m => { S.bookmarks = m.bookmarks || []; renderBookmarks(); });
  conn.on('perms', m => {
    S.perms = m.perms;
    applyPerms();
    const names = { playback: 'playback control', chat: 'chat', react: 'reactions', camera: 'camera and mic' };
    toast(`The host ${m.value ? 'gave you' : 'turned off'} ${names[m.changed] || m.changed}`, { timeout: 3500 });
  });
  conn.on('settings', m => { S.settings = m.settings; renderSettings(); renderPeople(); renderServicePanel(); });
  conn.on('toast', m => {
    if (m.kind === 'knock') { animateHandoff(m.name); toast(m.text, { kind: 'knock', timeout: 30000, actions: [
      { label: 'Let in', primary: true, run: () => conn.send({ type: 'admit', clientId: m.clientId }) },
      { label: 'Deny', run: () => conn.send({ type: 'deny', clientId: m.clientId }) }] }); }
    else if (m.kind === 'request') toast(m.text, { kind: 'request', timeout: 20000, actions: [
      { label: 'Allow', primary: true, run: () => conn.send({ type: 'set-perm', clientId: m.clientId, perm: 'playback', value: true }) },
      { label: 'Not now', run: () => {} }] });
    else toast(m.text, { kind: m.kind, timeout: m.timeout || 4000 });
  });
  conn.on('error', m => {
    if (m.code !== 'no-permission') return;
    noPerm(m.perm);
    // undo the instant local change if the room refused it
    if (m.perm === 'playback' && S.serverState) { S.state = S.serverState; player.setState(S.state); scheduleUi(); }
  });
  conn.on('force-media-off', async () => { await stopLocal('video'); await stopLocal('audio'); toast('The host turned off camera and mic for you'); });
  conn.on('ice', m => {
    mesh.setIceServers(m.iceServers, m.relayOnly);
    // reconnect the cameras with the new settings; the host starts it so both sides don't collide
    if (isHost) for (const id of S.peers.keys()) mesh.call(id).catch(() => {});
  });
  conn.on('peer-join', m => { S.peers.set(m.peer.id, m.peer); animateHandoff(m.peer.name); renderCams(); });
  conn.on('peer-leave', m => { S.peers.delete(m.id); mesh.closePeer(m.id); renderCams(); });
  conn.on('peer-media', m => { const p = S.peers.get(m.id); if (p) p.media = m.media; renderCams(); });
  conn.on('peer-rename', m => { const p = S.peers.get(m.id); if (p) p.name = m.name; if (m.id === clientId && S.me) S.me.name = m.name; renderCams(); });
  conn.on('rtc', m => mesh.onSignal(m.from, m.data));
  conn.on('library-changed', () => loadLibrarySoon());
  conn.on('library', m => { if (isHost || !m.library) return; S.library = m.library; renderLibrary(); });
  conn.on('yt-results', m => onYtResults(m));
  conn.on('job', m => updateJob(m.id, m.job));
  conn.on('network', () => refreshInfoSoon());
  conn.on('link-changed', () => { refreshInfo().then(() => openInvite()); toast('New invite link created. Share it with your guests again.'); });
}

function onWelcome(m) {
  S.me = m.you;
  S.perms = m.you.perms;
  S.settings = m.settings || {};
  S.reactions = m.reactions || [];
  S.bookmarks = m.bookmarks || [];
  mesh.setIceServers(m.iceServers, m.relayOnly);
  screen('room');
  $('#chatList').innerHTML = '';
  S.chatLog = [];
  S.lastSender = null;
  for (const c of m.chat || []) addChat(c, false);
  S.peers = new Map((m.peers || []).map(p => [p.id, p]));
  mesh.closeAll();
  for (const p of m.peers || []) mesh.call(p.id).catch(e => console.warn('call failed', e));
  S.state = m.state;
  loadMovie(m.movie);
  player.setState(m.state);
  if (S.cam || S.mic) conn.send({ type: 'media', cam: S.cam, mic: S.mic });
  buildReactions();
  renderBookmarks();
  applyPerms();
  renderSettings();
  renderNotice();
  if (isHost) {
    loadLibrary();
    refreshInfo();
    if (!m.movie && S.tab === 'chat' && !S._openedLib) { S._openedLib = true; setTab('library'); }
  }
}

function teardownMedia() {
  try { mesh && mesh.closeAll(); } catch {}
  for (const k of ['audio', 'video']) if (mesh && mesh.local[k]) { mesh.local[k].stop(); mesh.local[k] = null; }
  try { video.pause(); } catch {}
}

// ---------------------------------------------------------------- movie + player UI
const trackEls = new Map();

const kindOf = movie => (movie ? movie.kind || 'file' : '');

// Visual effects are local-only: policy inputs, sampled colors and preferences never leave this browser.
const visualPrefs = { ambient: store.get('wp.ambient', true), saver: store.get('wp.saver', false) };
let visuals = visualPolicy({ forcedSaver: visualPrefs.saver });
const ambientCanvas = Object.assign(document.createElement('canvas'), { width: 12, height: 7 });
const ambientContext = ambientCanvas.getContext('2d', { willReadFrequently: true });
let ambientFrame = 0, ambientTimer = 0, ambientSampleAt = 0;

function canUseAmbient() {
  return !!(visualPrefs.ambient && visuals.ambient && S.movie && kindOf(S.movie) === 'file' && video.readyState >= 2 && document.visibilityState === 'visible');
}
function renderVisualControls() {
  const ambient = $('#ambientBtn'), eco = $('#ecoBtn');
  const active = visualPrefs.ambient && visuals.ambient;
  ambient.classList.toggle('on', active);
  ambient.setAttribute('aria-pressed', String(active));
  ambient.title = active ? 'Ambient theater lighting is on' : `Ambient theater lighting is off${visuals.reasons.length ? ` (${visuals.reasons.join(', ')})` : ''}`;
  eco.classList.toggle('on', visuals.saver);
  eco.setAttribute('aria-pressed', String(visualPrefs.saver));
  eco.title = visuals.saver ? `Battery saver is on${visuals.reasons.length ? ` (${visuals.reasons.join(', ')})` : ''}` : 'Turn on battery saver';
  app.classList.toggle('motion-off', !visuals.motion);
}
function stopAmbientSampling() {
  if (ambientFrame) video.cancelVideoFrameCallback?.(ambientFrame);
  clearTimeout(ambientTimer);
  ambientFrame = ambientTimer = 0;
}
function sampleAmbient(now = performance.now()) {
  ambientFrame = ambientTimer = 0;
  if (!canUseAmbient()) return syncAmbient();
  if (now - ambientSampleAt >= 650 && ambientContext) {
    ambientSampleAt = now;
    try {
      ambientContext.drawImage(video, 0, 0, ambientCanvas.width, ambientCanvas.height);
      const pixels = ambientContext.getImageData(0, 0, ambientCanvas.width, ambientCanvas.height).data;
      let r = 0, g = 0, b = 0, weight = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const w = Math.max(0.15, (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 765);
        r += pixels[i] * w; g += pixels[i + 1] * w; b += pixels[i + 2] * w; weight += w;
      }
      stage.style.setProperty('--ambient-rgb', `${Math.round(r / weight)},${Math.round(g / weight)},${Math.round(b / weight)}`);
    } catch { stopAmbientSampling(); return; }
  }
  scheduleAmbientSample();
}
function scheduleAmbientSample() {
  if (!canUseAmbient() || video.paused || ambientFrame || ambientTimer) return;
  if (video.requestVideoFrameCallback) ambientFrame = video.requestVideoFrameCallback(sampleAmbient);
  else ambientTimer = setTimeout(sampleAmbient, 700);
}
function syncAmbient() {
  const available = canUseAmbient();
  $('#ambientLight').classList.toggle('on', available);
  if (available) scheduleAmbientSample(); else stopAmbientSampling();
  renderVisualControls();
}
function applyVisualPolicy(next) { visuals = next; syncAmbient(); }

const visualWatcher = observeVisualPolicy(applyVisualPolicy, () => visualPrefs.saver);
$('#ambientBtn').addEventListener('click', () => { visualPrefs.ambient = !visualPrefs.ambient; store.set('wp.ambient', visualPrefs.ambient); syncAmbient(); });
$('#ecoBtn').addEventListener('click', () => { visualPrefs.saver = !visualPrefs.saver; store.set('wp.saver', visualPrefs.saver); visualWatcher.refresh(); });
for (const event of ['play', 'pause', 'loadeddata', 'emptied']) video.addEventListener(event, syncAmbient);
document.addEventListener('visibilitychange', syncAmbient);

function mediaFor(movie) {
  const k = kindOf(movie);
  return k === 'youtube' ? ytMedia : k === 'service' ? remote : video;
}

function loadMovie(movie) {
  const same = S.movie && movie && S.movie.id === movie.id;
  if (!same) S.observatory = null;
  S.movie = movie;
  syncAmbient();
  stage.classList.toggle('has-movie', !!movie);
  stage.dataset.kind = kindOf(movie);
  $('#ytOpen').hidden = !((isHost || canControl()) && kindOf(movie) === 'youtube');
  renderNowPlaying();
  theaterReportSoon();
  renderServiceTiles();
  bringAlong(movie);
  renderLibraryCurrent();
  renderServicePanel();
  renderObservatory();
  renderBookmarks();
  if (!isHost && S.perms) applyPerms(); // a custom site takes control away from guests while it's on
  if (same) return;
  trackEls.clear();
  const media = mediaFor(movie);
  if (media !== M) {
    // carry the viewer's volume over to the new player
    const vol = store.get('wp.volume', 1);
    M = media;
    try { M.volume = vol; } catch {}
  }
  S.metaSent = null;
  S.fileSources = kindOf(movie) === 'file' ? deliverySources(movie, PLAYBACK, key, clientId) : [];
  S.fileSourceIndex = 0;
  player.setMovie(movie, S.fileSources[0] || null, media);
  if (movie && kindOf(movie) === 'file') {
    for (const s of movie.subs || []) {
      const t = document.createElement('track');
      t.kind = 'subtitles';
      t.label = s.label;
      if (s.lang) t.srclang = s.lang.slice(0, 3);
      t.src = `${s.url}?k=${encodeURIComponent(key)}`;
      video.appendChild(t);
      trackEls.set(s.key, t);
    }
    // restore subtitle choice by language
    const pref = store.get('wp.subLang', null);
    const match = pref && (movie.subs || []).find(s => s.lang === pref && !/forced/i.test(s.label));
    setTimeout(() => selectSub(match ? match.key : null, false), 0);
    checkCodecSupport(movie);
  } else {
    $('#emptyTitle').textContent = 'Nothing is playing yet';
    $('#emptyText').textContent = isHost ? 'Pick a movie from your library, then invite people.' : canControl() ? 'Pick a movie or a streaming service in the Library tab, or wait for the host.' : 'The host will pick a movie.';
  }
  if (movie && kindOf(movie) !== 'file') codecWarning = null;
  buildCcMenu();
  renderNotice();
}

// ---- streaming services (Netflix, Prime Video, ...) and YouTube
function serviceName(movie) { return (movie && (movie.serviceName || SERVICE_NAMES[movie.service])) || 'the service'; }

function renderServicePanel() {
  const panel = $('#servicePanel');
  const m = S.movie;
  if (!panel) return;
  stage.classList.toggle('service-setup', !!m && kindOf(m) === 'service' && !(remote && remote.present));
  if (!m || kindOf(m) !== 'service') { panel.hidden = true; return; }
  panel.hidden = false;
  const name = serviceName(m);
  const st = remote && remote.st;
  let status, button = '', help = '';
  const appleUrl = S.settings.safariExtensionUrl || S.info?.settings?.safariExtensionUrl || '';
  const target = installTarget(PLATFORM, appleUrl);
  const safariRuntime = remote && remote.platform === 'safari';
  if (!remote.present && target === 'android') {
    const hostName = (S.people.find(p => p.role === 'host') || {}).name || 'The host';
    status = `<div class="follow-clock"><span id="followState"></span><b id="followTime"></b></div>${esc(hostName)} is watching <b>${esc(m.title && m.title !== name ? m.title : 'something')}</b> on ${esc(name)}.`;
    button = `<a class="btn primary" href="${esc(m.url)}" target="_blank" rel="noopener">${isCustom() ? `Open ${esc(name)}` : `Open it in the ${esc(name)} app`}</a>`;
    help = `<p class="fine">Android browsers do not support this Safari/Chromium extension. Follow the live clock by hand; chat and reactions still work here.</p>`;
  } else if (!remote.present && PLATFORM.appleMobile) {
    const hostName = (S.people.find(p => p.role === 'host') || {}).name || 'The host';
    const live = `<div class="follow-clock"><span id="followState"></span><b id="followTime"></b></div>${esc(hostName)} is watching <b>${esc(m.title && m.title !== name ? m.title : 'something')}</b> on ${esc(name)}.`;
    if (target === 'apple-mobile-browser') {
      status = `<b>Open this party link in Safari</b> to use Watch Party Sync on ${esc(DEVICE)}. ${live}`;
      button = `<a class="btn" href="${esc(m.url)}" target="_blank" rel="noopener">Open ${esc(name)} for manual sync</a>`;
      help = `<p class="fine">Apple only enables Safari Web Extensions inside Safari. Copy this party link, open Safari, install the extension there, then reload the party.</p>`;
    } else if (target === 'apple-mobile') {
      status = `${live}<br><b>Install Watch Party Sync for Safari</b> to synchronize automatically.`;
      button = `<a class="btn primary" href="${esc(appleUrl)}" target="_blank" rel="noopener">Install the Safari extension</a><a class="btn" href="${esc(m.url)}" target="_blank" rel="noopener">Open ${esc(name)} manually</a>`;
      help = `<ol class="svc-steps"><li>Install the signed app from TestFlight or the App Store.</li><li>Open <b>Settings → Apps → Safari → Extensions → Watch Party Sync</b>, turn it on, and allow the streaming sites you use.</li><li>Return here in Safari, reload, then tap <b>Open in Safari</b>. On iPad, Split View keeps chat visible; on iPhone, use the extension's toolbar popup.</li></ol>`;
    } else {
      status = `${live}<br>The host has not published the signed Apple extension yet, so automatic Safari sync is not available on this ${esc(DEVICE)}.`;
      button = `<a class="btn primary" href="${esc(m.url)}" target="_blank" rel="noopener">Open ${esc(name)} for manual sync</a>`;
      help = `<p class="fine">Use the live clock to match play, pause, and position. The source is ready, but Apple requires a signed App Store or TestFlight app before an iPad or iPhone can install it.</p>`;
    }
  } else if (!remote.present && PLATFORM.safari) {
    status = `To watch together on ${esc(name)}, install <b>Watch Party Sync for Safari</b>. Everyone uses their own ${esc(name)} account.`;
    if (target === 'mac-safari') {
      button = `<a class="btn primary" href="${esc(appleUrl)}" target="_blank" rel="noopener">Install for Safari</a>`;
      help = `<ol class="svc-steps"><li>Install the app and enable <b>Watch Party Sync</b> in Safari → Settings → Extensions.</li><li>Allow access to this party and the streaming sites you use.</li><li>Reload this page.</li></ol>`;
    } else {
      button = `<a class="btn primary" href="/ext/watch-party-safari-source.zip" download>Download Safari extension source</a>`;
      help = `<ol class="svc-steps"><li>On a Mac with Xcode, extract the source ZIP.</li><li>Run <code>xcrun safari-web-extension-converter watch-party-safari</code>.</li><li>Open the generated project, choose your Apple signing team, and run its macOS app.</li><li>Enable Watch Party Sync in Safari → Settings → Extensions, then reload this page.</li></ol><p class="fine">The host can publish the signed build through TestFlight or the App Store to replace these developer steps.</p>`;
    }
  } else if (!remote.present) {
    const copy = (text, label) => `<button class="btn sm" type="button" data-copy="${esc(text)}">${esc(label || 'Copy')}</button>`;
    const addr = /Edg\//.test(navigator.userAgent) ? 'edge://extensions' : 'chrome://extensions';
    if (isHost) {
      if (!S.info) refreshInfoSoon();
      const dir = (S.info && S.info.extensionDir) || 'D:\\watch-party\\extension';
      status = `To watch together on ${esc(name)}, add the <b>Watch Party Sync</b> extension to this browser (one time). Everyone watches from their own ${esc(name)} account.`;
      help = `<ol class="svc-steps">
        <li>Copy this address <code>${addr}</code> ${copy(addr)} then paste it into a new tab's address bar and press Enter. (Browsers don't let pages open it for you.)</li>
        <li>Turn on <b>Developer mode</b> (top right in Chrome, left side in Edge).</li>
        <li>Click <b>Load unpacked</b> and choose your <code>${esc(dir)}</code> folder ${copy(dir, 'Copy folder')}</li>
        <li>Click the puzzle piece next to the address bar and pin <b>Watch Party Sync</b> so you can see it.</li>
        <li>Reload this tab.</li>
      </ol>
      <p class="fine">Your friends get it from their own party page: the same steps show there with a download button. They only need it for streaming services. Your own movies and YouTube work without it.</p>`;
    } else {
      status = `To watch together on ${esc(name)}, add the free <b>Watch Party Sync</b> extension (one time, about two minutes, Chrome or Edge on a computer). You'll sign in with your own ${esc(name)} account.`;
      help = `<ol class="svc-steps">
        <li><a class="btn sm primary" href="/ext/watch-party-sync.zip" download>Download the extension</a> then open your Downloads folder, right-click <b>watch-party-sync.zip</b> and choose <b>Extract All</b>.</li>
        <li>Copy this address <code>${addr}</code> ${copy(addr)} then paste it into a new tab's address bar and press Enter.</li>
        <li>Turn on <b>Developer mode</b> (top right in Chrome, left side in Edge).</li>
        <li>Click <b>Load unpacked</b> and choose the extracted <b>watch-party-sync</b> folder (the one with manifest.json inside).</li>
        <li>Come back to this tab and reload it. You stay in the party.</li>
      </ol>
      <p class="fine">Keep the extracted folder; the browser uses it from there. The extension only sees play, pause and position on streaming sites, never your password or anything else.</p>`;
    }
  } else if (extOutdated(remote.version)) {
    status = `Your <b>Watch Party Sync</b> extension is out of date (${esc(remote.version || '?')}). This party needs the newer one.`;
    help = safariRuntime
      ? (appleUrl ? `<p><a class="btn sm primary" href="${esc(appleUrl)}" target="_blank" rel="noopener">Update the Safari extension</a></p><p class="fine">After updating, reload this page.</p>` : `<p class="fine">Ask the host for the latest signed Safari build, then reload this page.</p>`)
      : isHost
      ? `<ol class="svc-steps"><li>Open <code>chrome://extensions</code> (Brave: <code>brave://extensions</code>).</li><li>Click the round <b>reload</b> arrow on Watch Party Sync.</li><li>Reload this tab.</li></ol>`
      : `<ol class="svc-steps"><li><a class="btn sm primary" href="/ext/watch-party-sync.zip" download>Download the new extension</a> and extract it over the old folder (replace the files).</li><li>Open <code>chrome://extensions</code> and click the round <b>reload</b> arrow on Watch Party Sync.</li><li>Reload this tab.</li></ol>`;
  } else if (!remote.linked || !st) {
    const hostName = (S.people.find(p => p.role === 'host') || {}).name || 'The host';
    const pickerName = m.by && m.by !== (S.me && S.me.name) ? m.by : hostName; // who picked it (the host, or a guest with control)
    status = isHost || (m.browsing && canControl())
      ? `Open ${esc(name)} and sign in with <b>your own</b> account if it asks. Press play on anything: the whole room follows what you're watching${isHost ? '' : `, ${esc(hostName)} included`}, and the party (chat, cameras, controls) sits in a panel next to it.`
      : m.browsing
        ? `${esc(pickerName)} is picking something on ${esc(name)}. Open ${esc(name)} now and sign in with <b>your own</b> ${esc(name)} account, so you're ready when they press play.`
        : `${esc(hostName)} is watching <b>${esc(m.title && m.title !== name ? m.title : 'something')}</b> on ${esc(name)}. Open it and sign in with <b>your own</b> ${esc(name)} account if it asks. Once the video starts, it follows the room automatically, and the party sits in a panel next to it.`;
    button = isTheater ? '' : safariRuntime
      ? `<button class="btn primary" type="button" data-svc="theater">Open ${esc(name)} in Safari</button>`
      : `<button class="btn primary" type="button" data-svc="theater">Watch here, in this window</button><button class="btn" type="button" data-svc="open">Open ${esc(name)} in its own tab</button>`;
    help = safariRuntime
      ? `<p class="fine">The player opens as a normal Safari tab so the site sees a standard browser page. Use the Watch Party toolbar popup for controls, or return here for chat.</p>`
      : `<p class="fine">Already have it open in another tab? Just press play there and it links up.</p>`;
    if (isCustom()) {
      // any website the host opened: it plays inside the Watch Party window, and only the host drives it
      status = isHost
        ? `<b>${esc(name)}</b> opens right here for everyone. Pick a video and press play: it plays for the whole room, in sync. Only you control it.`
        : `${esc(hostName)} opened <b>${esc(name)}</b>. Click <b>Watch here</b>: it opens in this window and plays along with ${esc(hostName)}. Only the host controls it.`;
      button = isTheater ? '' : `<button class="btn primary" type="button" data-svc="theater">${safariRuntime ? `Open ${esc(name)} in Safari` : 'Watch here, in this window'}</button>`;
      help = safariRuntime
        ? `<p class="fine">This opens as a normal Safari tab. Ad and pop-up blocking stays scoped to this host-selected site, while its own player scripts and buttons remain available.</p>`
        : `<p class="fine">If the video doesn't start by itself, click play once inside it. The browser sometimes needs one click there.</p>`;
    }
  } else {
    status = `<span class="svc-ok">Synced with your ${esc(name)} tab</span> · <span id="svcTime"></span>`;
    if (m.browsing && (isHost || canControl())) status = `<span class="svc-ok">${esc(name)} is open</span> · press play on anything and everyone follows.`;
    else if (m.browsing) status = `<span class="svc-ok">Ready on ${esc(name)}</span> · waiting for ${esc(m.by && m.by !== (S.me && S.me.name) ? m.by : 'the host')} to pick something.`;
    if (st.ad) status += `<br>An ad is playing in your tab. The room waits until it's over.`;
    if (st.blocked) status += `<br>Click play once inside the ${esc(name)} tab. The browser needs one click there.`;
    button = safariRuntime
      ? `<button class="btn primary" type="button" data-svc="show">Show ${esc(name)}</button>`
      : `<button class="btn primary" type="button" data-svc="panel">Show the party next to ${esc(name)}</button><button class="btn" type="button" data-svc="open">Open ${esc(name)} again</button>`;
    help = safariRuntime
      ? `<p class="fine">The video stays in its normal Safari tab. Tap the Watch Party extension in Safari's toolbar for compact controls; this party tab keeps chat, reactions, and room presence connected.</p>`
      : `<p class="fine">Watch in the ${esc(name)} tab. The party (chat, cameras, people and the play controls) sits in the panel on the right side of Chrome, next to the video. Closed it? Click the Watch Party icon in Chrome's toolbar, or the button above. Keep this tab open in the background: it's what keeps everyone connected.</p>`;
  }
  const html = `<div class="svc-card"><div class="svc-name">${esc(name)}</div><h2>${esc(m.title && m.title !== name ? m.title : `Watching on ${name}`)}</h2><p>${status}</p>${button ? `<div class="row" style="justify-content:center">${button}</div>` : ''}${help}</div>`;
  if (panel.innerHTML !== html) panel.innerHTML = html;
}
$('#servicePanel').addEventListener('click', e => {
  const c = e.target.closest('[data-copy]');
  if (c) {
    const done = () => toast('Copied', { timeout: 1500 });
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(c.dataset.copy).then(done, () => prompt('Copy this:', c.dataset.copy));
    else prompt('Copy this:', c.dataset.copy);
    return;
  }
  const b = e.target.closest('[data-svc]');
  if (b && b.dataset.svc === 'open') { togglePip({ keep: true, quiet: true }); remote.openPanel(); remote.openTab(); }
  if (b && b.dataset.svc === 'show') remote.showTab();
  if (b && b.dataset.svc === 'panel') remote.openPanel();
  if (b && b.dataset.svc === 'theater') enterTheater();
});

// The viewer used the streaming site's own play/pause/seek: share it with the room.
// It's held on this screen right away (so nothing undoes it), then sent to the room 0.7 s later,
// unless an ad started in the meantime (an ad pausing the show is not someone pressing pause).
let userActionTimer = null;
function onRemoteUserAction(m) {
  if (kindOf(S.movie) !== 'service') return;
  // the tab has moved on to another title (next episode, say): that's handled by following the tab,
  // not by moving the current title around
  if (m.url && canonicalUrl(m.url) !== canonicalUrl(S.movie.url) && !S.movie.browsing && performance.now() - (remote.urlChangedAt || -1e9) < 8000) return;
  if (!canControl()) { toast(isCustom() ? 'Only the host controls this site. Your video follows the host.' : 'Only people the host allows can play, pause or seek. Your tab will follow the room.', { timeout: 3500 }); return; }
  const t = Number(m.t);
  // (a jump that "landed": the site finished loading the new spot a moment after the room moved on,
  // so the room lines up with this screen; everyone else is close already and catches up smoothly)
  if (m.action === 'seek' && Math.abs(t - player.expected()) <= (m.land ? 0.4 : 2)) return;
  const at = conn.clock.now();
  if (m.action === 'pause') predict({ playing: false, position: t, anchor: at });
  else if (m.action === 'play') predict({ playing: true, position: t, anchor: at });
  else predict({ position: t, anchor: at });
  // A jump is sent to the room right away (an ad never jumps the show), so nothing in between can
  // pull this screen back to the old spot. Play / pause wait a moment for the ad check.
  if (m.action === 'seek') { sendCmd('seek', t); return; }
  clearTimeout(userActionTimer);
  userActionTimer = setTimeout(() => {
    if (remote.st && remote.st.ad) { if (S.serverState) { S.state = S.serverState; player.setState(S.state); } return; }
    const pos = m.action === 'play' ? t + Math.max(0, conn.clock.now() - at) / 1000 : t;
    sendCmd(m.action === 'seek' ? 'seek' : m.action, m.action === 'seek' ? t + Math.max(0, conn.clock.now() - at) / 1000 * (S.state.playing ? 1 : 0) : pos);
  }, 700);
}

// The host tells the room the real title and length once the player knows them.
function maybeSendMeta() {
  const m = S.movie;
  if (!(isHost || (canControl() && m && m.by && m.by === (S.me && S.me.name))) || !m || kindOf(m) === 'file' || !M.isAdapter) return;
  const title = (M === remote ? remote.st && remote.st.title : ytMedia.ready && ytMedia.p.getVideoData && ytMedia.p.getVideoData().title) || '';
  const duration = M.duration || 0;
  const key2 = `${m.id}|${title}|${Math.round(duration)}`;
  if (!duration && !title) return;
  if (S.metaSent === key2) return;
  S.metaSent = key2;
  conn.send({ type: 'movie-meta', id: m.id, title, duration });
}
setInterval(maybeSendMeta, 3000);

let codecWarning = null;
function checkCodecSupport(movie) {
  codecWarning = null;
  const probes = { hevc: 'video/mp4; codecs="hvc1.2.4.L150.B0"', av1: 'video/mp4; codecs="av01.0.08M.10"', h264: 'video/mp4; codecs="avc1.640028"' };
  const t = probes[movie.codec];
  if (t && !video.canPlayType(t)) {
    codecWarning = movie.codec === 'hevc'
      ? 'This browser can\'t play HEVC (4K Blu-ray) video. Try Chrome or Edge on a Windows or Mac computer, or Safari. If it still fails, the host can prepare a "Compress for streaming" copy.'
      : `This browser can't play ${codecLabel(movie.codec)} video.`;
  }
}

function renderNowPlaying() {
  const el = $('#nowPlaying');
  const m = S.movie;
  if (!m) { el.innerHTML = `<span class="muted">${isHost ? 'Pick a movie from the library' : 'Waiting for the host'}</span>`; return; }
  const chips = [];
  if (kindOf(m) !== 'file') {
    el.innerHTML = `<span class="title">${esc(m.title || serviceName(m))}</span><span class="chip">${esc(serviceName(m))}</span>`;
    return;
  }
  const r = resLabel(m.width, m.height);
  if (r) chips.push(`<span class="chip">${r}</span>`);
  if (m.hdr) chips.push(`<span class="chip hdr">${esc(m.hdr.replace(' + HDR10', ''))}</span>`);
  if (m.audio) chips.push(`<span class="chip hide-sm">${esc(m.audio.replace(/ \(from .*\)/, ''))}</span>`);
  if (isHost && m.mbps) chips.push(`<span class="chip hide-sm" title="Movie bitrate">${m.mbps} Mbps</span>`);
  if (isHost && S.totalMbps > 0.5) chips.push(`<span class="chip hide-sm" title="How much you're uploading to viewers right now">↑ ${S.totalMbps} Mbps</span>`);
  el.innerHTML = `<span class="title">${esc(m.title)}</span>${chips.join('')}`;
}

// UI refresh is batched to one animation frame
let uiQueued = false;
function scheduleUi() { if (!uiQueued) { uiQueued = true; requestAnimationFrame(() => { uiQueued = false; renderControls(); }); } }
setInterval(scheduleUi, 250);

let dragFrac = null;
function renderControls() {
  if (!S.movie) return;
  const dur = S.movie.duration || M.duration || 0;
  const cur = dragFrac != null ? dragFrac * dur : (M.readyState >= 1 ? M.currentTime : player.expected());
  $('#time').textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
  const pct = dur ? Math.min(100, (cur / dur) * 100) : 0;
  $('#seekPlayed').style.width = pct + '%';
  $('#seekThumb').style.left = pct + '%';
  const ahead = player.bufferedAhead();
  $('#seekBuffered').style.width = dur ? Math.min(100, ((M.currentTime + ahead) / dur) * 100) + '%' : '0%';
  const svcTime = document.getElementById('svcTime');
  if (svcTime) svcTime.textContent = dur ? `${fmtTime(cur)} / ${fmtTime(dur)}` : fmtTime(cur);
  const playing = !!(S.state && (S.state.playing || S.state.waiting));
  const pb = $('#playBtn');
  const want = playing ? 'pause' : 'play';
  if (pb.dataset.icon !== want) { pb.dataset.icon = want; pb.innerHTML = icon(want); pb.setAttribute('aria-label', playing ? 'Pause' : 'Play'); }
  const muted = M.muted || M.volume === 0;
  const mb = $('#muteBtn');
  const mi = muted ? 'mute' : 'vol';
  if (mb.dataset.icon !== mi) { mb.dataset.icon = mi; mb.innerHTML = icon(mi); }
  // local buffering notice
  const buffering = S.state && S.state.playing && conn.clock.now() > S.state.anchor + 600 && (M.readyState < 3 || M.seeking) && !M.error;
  if (buffering !== S._buffering) { S._buffering = buffering; renderNotice(); }
}

function renderNotice() {
  const el = $('#stageNotice');
  let html = '';
  if (S.movie) {
    if (M.error && M.isAdapter) {
      html = `<span>${esc(M.error.yt === 101 || M.error.yt === 150 ? 'The owner of this YouTube video doesn\'t allow playing it outside YouTube. The host can show it with "Everyone opens it in their own tab" instead.' : 'This video couldn\'t be loaded.')}</span>`;
    } else if (M === remote) {
      html = ''; // the service panel explains what to do
    } else if (video.error) {
      html = `<span>${esc(codecWarning || 'Your browser couldn\'t play this movie. Try Chrome or Edge, or ask the host to prepare a compressed copy.')}</span>`;
    } else if (codecWarning && video.readyState < 1) {
      html = `<span>${esc(codecWarning)}</span>`;
    } else if (player && player.videoFailed && !pictureHintHidden(S.movie.id)) {
      html = `<span>Only hearing sound with a black picture? Turn on Chrome's "Use graphics acceleration" setting, or ask the host to prepare a "Compress for streaming" copy.</span><button class="btn sm" type="button" data-hide-hint>Hide</button>`;
    } else if (player && player.syncing && !S._buffering) {
      html = `<div class="spinner"></div><span>Catching up with the room…</span>`;
    } else if (S.state && S.state.waiting) {
      const who = (S.state.waitingFor || []).filter(n => n !== S.me?.name);
      html = `<div class="spinner"></div><span>${who.length ? `Waiting for ${esc(who.join(', '))} to catch up…` : 'Getting everyone in sync…'}</span>`;
    } else if (S._buffering) {
      html = `<div class="spinner"></div><span>Buffering…</span>`;
    } else if (player && player.blocked) {
      html = `<span>Click anywhere to start watching</span>`;
    }
  }
  el.hidden = !html;
  if (el.innerHTML !== html) el.innerHTML = html;
}

video.addEventListener('error', () => {
  const next = S.fileSources?.[++S.fileSourceIndex];
  if (next) {
    video.src = next;
    video.load();
    toast('Safari streaming was unavailable, so playback switched to the original file.', { timeout: 5000 });
  }
  renderNotice();
});

// "Hide" on the picture hint: don't show it again for this movie (or at all after two hides)
function pictureHintHidden(id) {
  try { const h = JSON.parse(localStorage.getItem('wp.hideHint') || '[]'); return h.length >= 2 || h.includes(id); } catch { return false; }
}
$('#stageNotice').addEventListener('click', e => {
  if (!e.target.closest('[data-hide-hint]') || !S.movie) return;
  e.stopPropagation();
  try { const h = JSON.parse(localStorage.getItem('wp.hideHint') || '[]'); h.push(S.movie.id); localStorage.setItem('wp.hideHint', JSON.stringify(h.slice(-50))); } catch { /* private window */ }
  renderNotice();
});

// --- permissions
// a custom site (any website the host opened) is the host's alone: guests watch, the host drives
const isCustom = () => !!(S.movie && S.movie.service === 'custom');
const canControl = () => isHost || (!!S.perms.playback && !isCustom());
function noPerm(perm) {
  const text = { playback: 'Only people the host allows can play, pause or seek.', chat: 'The host turned off chat for you.', react: 'The host turned off reactions for you.', camera: 'The host hasn\'t allowed you to use your camera or mic.' }[perm] || 'Not allowed.';
  if (perm === 'playback' && isCustom()) return toast('Only the host controls this site. Your video follows the host.', { timeout: 3500 });
  const actions = perm === 'playback' ? [{ label: 'Ask the host', primary: true, run: () => { conn.send({ type: 'request-control' }); toast('Asked the host for control', { timeout: 2000 }); } }] : [];
  toast(text, { actions, timeout: 4500 });
}
function applyPerms() {
  const ctl = canControl();
  // guests with control also get the library and can pick what the room watches
  const had = app.classList.contains('can-control');
  app.classList.toggle('can-control', !isHost && ctl);
  $('#libGuestNote').hidden = isHost;
  if (!isHost && ctl && !had) loadLibrarySoon();
  if (!isHost && !ctl && had && S.tab === 'library') setTab('chat');
  for (const id of ['#playBtn', '#backBtn', '#fwdBtn']) $(id).classList.toggle('denied', !ctl);
  $('#seek').classList.toggle('locked', !ctl);
  const chatOk = isHost || S.perms.chat;
  $('#chatInput').disabled = !chatOk;
  $('#quickChatInput').disabled = !chatOk;
  $('#chatInput').placeholder = chatOk ? 'Message everyone' : 'The host turned off chat for you';
  $('#chatForm').classList.toggle('disabled', !chatOk);
  $('#reactBtn').classList.toggle('denied', !(isHost || S.perms.react));
  const camOk = isHost || S.perms.camera;
  $('#camBtn').classList.toggle('denied', !camOk);
  $('#micBtn').classList.toggle('denied', !camOk);
  renderBookmarks();
  renderPeople();
}

// --- transport controls
// Controls react instantly on your own screen; the room follows a moment later.
function localPos() { return M.readyState >= 1 ? M.currentTime : player.expected(); }
function predict(patch) {
  S.state = { ...S.state, waiting: false, waitingFor: [], ...patch };
  player.setState(S.state);
  renderNotice();
  scheduleUi();
}
// Every command carries a number; the room's answer says which one it answers. While more of our
// own commands are on the way, an answer to an older one is not applied (it would pull the screen
// back to an earlier spot in the middle of quick skips).
let cmdRef = 0;
const seekOut = { at: -1e9, timer: null, pos: null, clickAt: 0 };
function sendCmd(action, position) {
  if (!canControl()) return noPerm('playback');
  if (!S.movie || !S.state) return;
  const at = conn.clock.now();
  if (action === 'seek') { predict({ position, anchor: at }); queueSeek(position, at); return; }
  // a play/pause replaces any skip still waiting to go out (the skip's spot is where it plays/pauses)
  if (seekOut.timer) { clearTimeout(seekOut.timer); seekOut.timer = null; }
  conn.send({ type: 'cmd', action, position, at, ref: ++cmdRef });
  if (action === 'pause') predict({ playing: false, position, anchor: at });
  else if (action === 'play') predict({ playing: true, position, anchor: at });
}
// Skips go out at most every 300 ms: the first one at once (no delay for a single skip), then one
// with where a burst of quick skips ends up. Everyone else loads one new spot instead of five.
function queueSeek(position, at) {
  seekOut.pos = position; seekOut.clickAt = at;
  const now = performance.now();
  if (!seekOut.timer && now - seekOut.at >= 300) { flushSeek(); return; }
  if (!seekOut.timer) seekOut.timer = setTimeout(flushSeek, Math.max(30, 300 - (now - seekOut.at)));
}
function flushSeek() {
  seekOut.timer = null;
  seekOut.at = performance.now();
  if (seekOut.pos == null) return;
  // anchored at the moment of the last press, so the timeline is exactly what this screen shows
  conn.send({ type: 'cmd', action: 'seek', position: seekOut.pos, at: seekOut.clickAt, ref: ++cmdRef });
  seekOut.pos = null;
}
const staleOwnEcho = m => m.byId && m.byId === clientId && m.ref != null && (m.ref !== cmdRef || !!seekOut.timer);
function togglePlay() {
  if (player.blocked || player.autoMuted) { unblock(); if (!canControl()) return; }
  const playing = S.state && (S.state.playing || S.state.waiting);
  if (!canControl()) return noPerm('playback');
  const pos = localPos();
  osd(playing ? 'Paused' : 'Play');
  sendCmd(playing ? 'pause' : 'play', pos);
}
// Pressing skip several times quickly adds up (+10, +20, +30) instead of fighting itself.
let seekChain = null;
function seekBy(d) {
  if (!canControl()) return noPerm('playback');
  if (!S.movie) return;
  const dur = S.movie.duration || M.duration || Infinity;
  const base = seekChain && performance.now() - seekChain.t < 1500 ? seekChain.target : localPos();
  const target = Math.max(0, Math.min(dur - 0.5, base + d));
  const total = (seekChain && performance.now() - seekChain.t < 1500 ? seekChain.total : 0) + d;
  const burst = !!(seekChain && performance.now() - seekChain.t < 1500);
  seekChain = { target, total, t: performance.now() };
  osd(`${total >= 0 ? '+' : '−'}${Math.abs(total)} s`);
  // Netflix, YouTube & co take a moment to load each new spot: during a burst of skips, jump there
  // once, where the burst ends, instead of loading every spot in between
  if (burst && M.isAdapter) {
    M.holdUntil = Math.max(M.holdUntil || 0, performance.now() + 330);
    clearTimeout(seekBy.t); seekBy.t = setTimeout(() => player.correct(), 350);
  }
  sendCmd('seek', target);
}
// small on-screen confirmation (volume, skip, play/pause)
let osdTimer = null;
function osd(text) {
  const el = $('#osd');
  el.textContent = text;
  el.hidden = false;
  el.classList.remove('fade');
  clearTimeout(osdTimer);
  osdTimer = setTimeout(() => { el.classList.add('fade'); osdTimer = setTimeout(() => { el.hidden = true; }, 300); }, 700);
}
function changeVolume(delta) {
  if (player.autoMuted) unblock();
  let v = Math.round(Math.max(0, Math.min(1, (M.muted ? 0 : M.volume) + delta)) * 100) / 100;
  M.volume = v;
  M.muted = v === 0;
  $('#volume').value = v;
  store.set('wp.volume', v);
  osd(v === 0 ? 'Muted' : `Volume ${Math.round(v * 100)}%`);
  scheduleUi();
}
function unblock() { player.unblock(); $('#unmutePill').hidden = true; renderNotice(); scheduleUi(); }

$('#playBtn').addEventListener('click', togglePlay);
$('#backBtn').addEventListener('click', () => seekBy(-10));
$('#fwdBtn').addEventListener('click', () => seekBy(10));
$('#unmutePill').addEventListener('click', e => { e.stopPropagation(); unblock(); });
let tapWasIdle = false, lastPointerType = 'mouse';
stage.addEventListener('pointerdown', e => { lastPointerType = e.pointerType; }, true);
// Swipe on the picture to skip 20 seconds: a finger on phones and tablets (swipe right: forward,
// left: back), or two fingers sideways on a laptop trackpad. Several quick swipes add up.
const SWIPE_SKIP = 20;
let swipedAt = 0;
(() => {
  const onPicture = t => t === video || (t && t.id === 'clickLayer');
  // Finger swipes (phones, tablets, touch-screen laptops). Touch events where the device has them: a
  // sideways move is claimed so the browser doesn't also scroll or go back a page. Pens: pointer events.
  const noSwipe = t => !t || !t.closest || !!t.closest('.controls, button, input, select, textarea, .cams, .chat-float, .quick-chat, .toasts, .pop');
  let sw = null;
  const begin = (x, y, target, id) => { sw = noSwipe(target) ? null : { id, x, y, at: performance.now(), wasIdle: stage.dataset.idle === 'true', claimed: false }; };
  const finish = (x, y, id) => {
    const st = sw; sw = null;
    if (!st || st.id !== id) return;
    const dx = x - st.x, dy = y - st.y;
    if (Math.abs(dx) < Math.max(40, Math.min(100, stage.clientWidth * 0.08)) || Math.abs(dx) < Math.abs(dy) * 1.3 || performance.now() - st.at > 1200) return;
    swipedAt = performance.now();
    seekBy(dx > 0 ? SWIPE_SKIP : -SWIPE_SKIP);
    if (st.wasIdle) { setIdle(true); clearTimeout(idleTimer); } // just skip, don't bring up the controls
  };
  stage.addEventListener('touchstart', e => { if (e.touches.length === 1) begin(e.touches[0].clientX, e.touches[0].clientY, e.target, 'touch'); else sw = null; }, { capture: true, passive: true });
  stage.addEventListener('touchmove', e => {
    if (!sw || sw.id !== 'touch' || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - sw.x, dy = e.touches[0].clientY - sw.y;
    if (!sw.claimed && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) sw.claimed = true;
    if (sw.claimed && e.cancelable) e.preventDefault();
  }, { capture: true, passive: false });
  stage.addEventListener('touchend', e => { if (e.changedTouches.length) finish(e.changedTouches[0].clientX, e.changedTouches[0].clientY, 'touch'); }, { capture: true, passive: true });
  stage.addEventListener('touchcancel', () => { sw = null; }, { capture: true, passive: true });
  const hasTouchEvents = 'ontouchstart' in window;
  stage.addEventListener('pointerdown', e => { if (e.pointerType === 'mouse' || !e.isPrimary || (e.pointerType === 'touch' && hasTouchEvents)) return; begin(e.clientX, e.clientY, e.target, e.pointerId); }, true);
  stage.addEventListener('pointerup', e => { if (sw && sw.id === e.pointerId) finish(e.clientX, e.clientY, e.pointerId); }, true);
  // trackpad: sideways scrolling; one skip per swipe (the scroll keeps coming for a moment after the fingers lift)
  let sum = 0, lastWheel = 0, fired = false;
  stage.addEventListener('wheel', e => {
    if (!onPicture(e.target) || e.ctrlKey) return;
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    e.preventDefault(); // otherwise the browser takes it as "go back a page"
    const now = performance.now();
    if (now - lastWheel > 500) { sum = 0; fired = false; }
    lastWheel = now;
    if (fired) return;
    sum += e.deltaMode === 1 ? e.deltaX * 16 : e.deltaX;
    if (Math.abs(sum) > 90) { fired = true; swipedAt = now; seekBy(sum > 0 ? SWIPE_SKIP : -SWIPE_SKIP); }
  }, { passive: false });
})();
const onStageClick = () => {
  if (performance.now() - swipedAt < 500) return; // the end of a swipe is not a tap
  if (player.blocked || player.autoMuted) { unblock(); return; }
  if (tapWasIdle) return; // first tap/click just brings the controls back
  if (lastPointerType === 'touch') { setIdle(true); clearTimeout(idleTimer); return; } // tap again hides them
  togglePlay();
};
video.addEventListener('click', onStageClick);
video.addEventListener('dblclick', () => toggleFullscreen());
$('#clickLayer').addEventListener('click', onStageClick);
$('#clickLayer').addEventListener('dblclick', () => toggleFullscreen());

// volume
const vol = $('#volume');
video.volume = store.get('wp.volume', 1);
vol.value = video.volume;
vol.addEventListener('input', () => { M.volume = +vol.value; M.muted = +vol.value === 0; store.set('wp.volume', M.volume); if (player.autoMuted) unblock(); scheduleUi(); });
$('#muteBtn').addEventListener('click', () => { if (player.autoMuted) { unblock(); return; } M.muted = !M.muted; scheduleUi(); });

// seek bar
(() => {
  const seek = $('#seek'), tip = $('#seekTip');
  const frac = e => { const r = seek.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  const showTip = f => { const dur = S.movie?.duration || 0; tip.textContent = fmtTime(f * dur); tip.style.left = (f * 100) + '%'; };
  seek.addEventListener('pointermove', e => { const f = frac(e); showTip(f); if (dragFrac != null) { dragFrac = f; scheduleUi(); } });
  seek.addEventListener('pointerdown', e => {
    if (!canControl()) return noPerm('playback');
    seek.setPointerCapture(e.pointerId);
    seek.classList.add('dragging');
    dragFrac = frac(e); showTip(dragFrac); scheduleUi();
  });
  const end = e => {
    if (dragFrac == null) return;
    const f = dragFrac; dragFrac = null;
    seek.classList.remove('dragging');
    sendCmd('seek', f * (S.movie?.duration || 0));
  };
  seek.addEventListener('pointerup', end);
  seek.addEventListener('pointercancel', () => { dragFrac = null; seek.classList.remove('dragging'); });
})();

// fullscreen
function isFs() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
function toggleFullscreen() {
  if (isFs()) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
  if (stage.requestFullscreen) stage.requestFullscreen().catch(() => {});
  else if (stage.webkitRequestFullscreen) stage.webkitRequestFullscreen();
  else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); // iPhone
}
$('#fsBtn').addEventListener('click', toggleFullscreen);
const onFs = () => { const fs = isFs(); stage.classList.toggle('is-fs', fs); $('#fsBtn').innerHTML = icon(fs ? 'fs-exit' : 'fs'); };
document.addEventListener('fullscreenchange', onFs);
document.addEventListener('webkitfullscreenchange', onFs);

// idle: hide controls while watching.
// The controls are really removed (display: none) once they have faded out, and put back the
// same way. Only fading them (opacity) is not enough on some Windows PCs: in fullscreen Chrome
// hands the video straight to the graphics card and then never repaints a faded-in layer on top,
// so the controls came back for key presses (which also show a new message) but not for the mouse.
let idleTimer = null, goneTimer = null;
const controlsEl = $('#controls');
function setIdle(idle) {
  clearTimeout(goneTimer);
  if (idle) {
    stage.dataset.idle = 'true';
    goneTimer = setTimeout(() => { if (stage.dataset.idle === 'true') controlsEl.classList.add('gone'); }, 300);
  } else {
    controlsEl.classList.remove('gone');
    stage.dataset.idle = 'false';
  }
}
// Paused (or waiting for someone): the controls stay on screen.
setInterval(() => { if (!(S.state && S.state.playing) && stage.dataset.idle !== 'false') poke(); }, 300);
function poke() {
  if (stage.dataset.idle !== 'false' || controlsEl.classList.contains('gone')) setIdle(false);
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const busy = !$('#reactPop').hidden || !$('#ccPop').hidden || !$('#quickChat').hidden || stage.querySelector('.controls:hover') || dragFrac != null;
    if (S.state && S.state.playing && !busy) setIdle(true); else poke();
  }, 2800);
}
// Listen on the whole page (capture phase, so nothing in between can swallow it) and for both
// mouse and pointer events: some Windows setups only deliver one kind in fullscreen.
let lastMove = 0;
const wake = e => {
  if (e && e.type.endsWith('move')) { const now = performance.now(); if (now - lastMove < 60) return; lastMove = now; }
  // remember whether the controls were hidden when this tap began (this runs before anything on the
  // stage sees the tap, and is what brings the controls back): a first tap only shows them
  if (e && (e.type === 'pointerdown' || e.type === 'touchstart')) {
    const now = performance.now();
    if (now - (wake.tapAt || 0) > 400) tapWasIdle = stage.dataset.idle === 'true' || controlsEl.classList.contains('gone'); // one tap fires both events
    wake.tapAt = now;
    if (e.pointerType) lastPointerType = e.pointerType;
  }
  if (isFs() || !e || !e.target || !e.target.closest || e.target.closest('#stage')) poke();
};
for (const ev of ['pointermove', 'mousemove', 'pointerdown', 'wheel', 'touchstart']) document.addEventListener(ev, wake, { capture: true, passive: true });
document.addEventListener('fullscreenchange', () => poke());
document.addEventListener('webkitfullscreenchange', () => poke());
poke();

// popovers
function closePops(except) { for (const p of ['#reactPop', '#ccPop']) if (p !== except) $(p).hidden = true; }
function togglePop(id) { const el = $(id); const open = el.hidden; closePops(id); el.hidden = !open; poke(); }
document.addEventListener('click', e => { if (!e.target.closest('.pop-wrap')) closePops(); });

// subtitles
function buildCcMenu() {
  const pop = $('#ccPop');
  const subs = S.movie?.subs || [];
  const active = [...trackEls.entries()].find(([, t]) => t.track && t.track.mode === 'showing');
  let html = '<div class="menu-label">Subtitles</div>';
  html += `<button type="button" data-sub="" class="${!active ? 'sel' : ''}">Off</button>`;
  for (const s of subs) html += `<button type="button" data-sub="${esc(s.key)}" class="${active && active[0] === s.key ? 'sel' : ''}">${esc(s.label)}</button>`;
  if (!subs.length) html += '<div class="menu-note">No text subtitles for this movie. Blu-ray image subtitles (PGS) can\'t be shown in browsers. Put a .srt file next to the movie with the same name to add one.</div>';
  pop.innerHTML = html;
  $('#ccBtn').classList.toggle('on', !!active);
}
function selectSub(k, remember = true) {
  for (const [key2, t] of trackEls) if (t.track) t.track.mode = key2 === k ? 'showing' : 'disabled';
  if (remember) {
    const s = (S.movie?.subs || []).find(x => x.key === k);
    store.set('wp.subLang', s ? s.lang : null);
  }
  buildCcMenu();
}
$('#ccBtn').addEventListener('click', e => { e.stopPropagation(); buildCcMenu(); togglePop('#ccPop'); });
$('#ccPop').addEventListener('click', e => { const b = e.target.closest('[data-sub]'); if (!b) return; selectSub(b.dataset.sub || null); closePops(); });

// ---------------------------------------------------------------- reactions
function buildReactions() {
  $('#reactPop').innerHTML = S.reactions.map(r => `<button type="button" data-emoji="${r}">${r}</button>`).join('');
}
$('#reactBtn').addEventListener('click', e => { e.stopPropagation(); if (!(isHost || S.perms.react)) return noPerm('react'); togglePop('#reactPop'); });
$('#reactPop').addEventListener('click', e => { const b = e.target.closest('[data-emoji]'); if (b) conn.send({ type: 'react', emoji: b.dataset.emoji }); });
function scheduleReaction(m) {
  const fire = () => {
    if (m.movieId && m.movieId !== S.movie?.id) return;
    if (m.at && conn.clock.now() - m.at > 2500) return;
    floatReaction(m.emoji, m.name);
  };
  const delay = Number(m.at) - conn.clock.now();
  if (Number.isFinite(delay) && delay > 10) setTimeout(fire, Math.min(delay, 2000)); else fire();
}
function floatReaction(emoji, name) {
  if (M === remote) remote.overlay({ kind: 'react', emoji, name });
  const layer = $('#reactionsLayer');
  if (layer.childElementCount > 40) layer.firstElementChild.remove();
  const el = document.createElement('div');
  el.className = 'floater';
  el.style.left = (8 + Math.random() * 78) + '%';
  el.style.setProperty('--dx', `${Math.round(Math.random() * 80 - 40)}px`);
  el.innerHTML = `<span class="e">${esc(emoji)}</span><span class="n">${esc(name)}</span>`;
  layer.appendChild(el);
  setTimeout(() => el.remove(), 2900);
}

// ---------------------------------------------------------------- toasts
function toast(text, { kind = 'info', actions = [], timeout = 4000 } = {}) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="t">${esc(text)}</span>${actions.length ? `<span class="acts">${actions.map((a, i) => `<button type="button" class="btn sm ${a.primary ? 'primary' : ''}" data-i="${i}">${esc(a.label)}</button>`).join('')}</span>` : ''}`;
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-i]');
    if (b) { actions[+b.dataset.i].run(); el.remove(); }
  });
  box.appendChild(el);
  while (box.childElementCount > 4) box.firstElementChild.remove();
  setTimeout(() => el.remove(), timeout);
}

// ---------------------------------------------------------------- chat
function addChat(m, live) {
  S.chatLog.push({ id: m.id, name: m.name || '', text: m.text || '', ts: m.ts || Date.now(), host: !!m.host, system: !!m.system, me: m.from === clientId, movieId: m.movieId || null, position: Number.isFinite(m.position) ? m.position : null });
  if (S.chatLog.length > 120) S.chatLog.splice(0, S.chatLog.length - 120);
  dockPushSoon();
  popRender(false);
  const list = $('#chatList');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  const el = document.createElement('div');
  if (m.system) {
    el.className = 'msg system';
    el.textContent = m.text;
    S.lastSender = null;
  } else {
    const cont = S.lastSender === m.from && m.ts - S.lastSenderTs < 120000;
    S.lastSender = m.from; S.lastSenderTs = m.ts;
    el.className = 'msg' + (cont ? ' cont' : '');
    const t = new Date(m.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const moment = Number.isFinite(m.position) ? `<button class="chat-time" type="button" data-chat-position="${m.position}" data-chat-movie="${esc(m.movieId || '')}" title="Jump to this moment">${fmtTime(m.position)}</button>` : '';
    el.innerHTML = `${avatar(m.name)}<div><div class="who">${esc(m.name)}${m.host ? ' <span class="host-tag">HOST</span>' : ''}<time>${t}</time></div><div class="body">${esc(m.text)}${moment}</div></div>`;
    if (live) floatChat(m);
    if (live && M === remote) remote.overlay({ kind: 'chat', name: m.name, text: m.text });
  }
  list.appendChild(el);
  while (list.childElementCount > 300) list.firstElementChild.remove();
  if (atBottom || !live || m.from === clientId) list.scrollTop = list.scrollHeight;
  const visible = S.tab === 'chat' && !room.classList.contains('no-sidebar') && !isFs();
  if (live && !m.system && !visible && m.from !== clientId) { S.unread++; renderBadges(); }
}
$('#chatList').addEventListener('click', e => {
  const b = e.target.closest('[data-chat-position]');
  if (!b || b.dataset.chatMovie !== S.movie?.id) return;
  sendCmd('seek', Number(b.dataset.chatPosition));
});

function renderBookmarks() {
  const list = $('#bookmarkList');
  const marks = (S.bookmarks || []).filter(x => x.movieId === S.movie?.id);
  $('#momentsBar').hidden = !marks.length && !canControl();
  list.innerHTML = marks.map(m => `<span class="moment"><button type="button" data-bookmark="${esc(m.id)}" title="${esc(m.name)} · ${fmtTime(m.position)}">${esc(m.label)} <em>${fmtTime(m.position)}</em></button>${(isHost || m.from === clientId) ? `<button type="button" data-remove-bookmark="${esc(m.id)}" aria-label="Remove ${esc(m.label)}">×</button>` : ''}</span>`).join('');
  $('#seekMoments').innerHTML = marks.map(m => `<i style="left:${Math.max(0, Math.min(100, m.position / Math.max(1, S.movie?.duration || M.duration || 1) * 100))}%" title="${esc(m.label)} · ${fmtTime(m.position)}"></i>`).join('');
}
$('#bookmarkBtn').addEventListener('click', () => {
  if (!canControl()) return noPerm('playback');
  if (!S.movie) return;
  const label = prompt('Name this scene (optional):', '') ?? null;
  if (label != null) conn.send({ type: 'bookmark', label });
});
$('#bookmarkList').addEventListener('click', e => {
  const remove = e.target.closest('[data-remove-bookmark]');
  if (remove) { conn.send({ type: 'bookmark', action: 'remove', id: remove.dataset.removeBookmark }); return; }
  const button = e.target.closest('[data-bookmark]');
  const mark = button && S.bookmarks.find(x => x.id === button.dataset.bookmark);
  if (mark) sendCmd('seek', mark.position);
});
function floatChat(m) {
  const box = $('#chatFloat');
  const el = document.createElement('div');
  el.className = 'cf';
  el.innerHTML = `<b>${esc(m.name)}</b>${esc(m.text)}`;
  box.appendChild(el);
  while (box.childElementCount > 5) box.firstElementChild.remove();
  setTimeout(() => el.classList.add('fade'), 7000);
  setTimeout(() => el.remove(), 7800);
}
function sendChat(input) {
  const text = input.value.trim();
  if (!text) return;
  if (!(isHost || S.perms.chat)) return noPerm('chat');
  conn.send({ type: 'chat', text });
  input.value = '';
}
$('#chatForm').addEventListener('submit', e => { e.preventDefault(); sendChat($('#chatInput')); });
$('#quickChat').addEventListener('submit', e => { e.preventDefault(); sendChat($('#quickChatInput')); $('#quickChat').hidden = true; poke(); });
function openQuickChat() { $('#quickChat').hidden = false; $('#quickChatInput').focus(); poke(); }
$('#quickChatBtn').addEventListener('click', openQuickChat);
$('#quickChatInput').addEventListener('keydown', e => { if (e.key === 'Escape') { $('#quickChat').hidden = true; e.stopPropagation(); } });

function renderBadges() {
  const b = $('#chatBadge');
  b.hidden = !S.unread;
  b.textContent = S.unread > 9 ? '9+' : S.unread;
  const pending = isHost ? S.people.filter(p => !p.admitted).length : 0;
  const pb = $('#peopleBadge');
  pb.hidden = !pending;
  pb.textContent = pending;
}

// ---------------------------------------------------------------- tabs / sidebar
function setTab(t) {
  S.tab = t;
  for (const b of $$('.tab')) b.classList.toggle('active', b.dataset.tab === t);
  for (const p of $$('.panel')) p.classList.toggle('active', p.dataset.panel === t);
  if (t === 'chat') { S.unread = 0; renderBadges(); const l = $('#chatList'); l.scrollTop = l.scrollHeight; }
  if (t === 'library') loadLibrary();
}
function transitionTab(t) {
  if (visuals.motion && document.startViewTransition && S.tab !== t) document.startViewTransition(() => setTab(t));
  else setTab(t);
}
for (const b of $$('.tab')) b.addEventListener('click', () => transitionTab(b.dataset.tab));
for (const b of $$('[data-open-tab]')) b.addEventListener('click', () => { room.classList.remove('no-sidebar'); setTab(b.dataset.openTab); });
setTab('chat');
if (store.get('wp.sidebar', true) === false) room.classList.add('no-sidebar');
$('#sidebarBtn').addEventListener('click', () => {
  room.classList.toggle('no-sidebar');
  store.set('wp.sidebar', !room.classList.contains('no-sidebar'));
  if (!room.classList.contains('no-sidebar') && S.tab === 'chat') { S.unread = 0; renderBadges(); }
});

// ---------------------------------------------------------------- keyboard
document.addEventListener('keydown', e => {
  if (app.dataset.screen !== 'room') return;
  // sliders (volume, seek bar) and buttons keep focus after a click; the arrow keys should still work then
  const field = e.target.closest('input:not([type=range]):not([type=checkbox]):not([type=radio]):not([type=button]), textarea, select, [contenteditable]');
  if (e.key === 'Escape') { closePops(); $('#quickChat').hidden = true; return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  // in an empty chat box, up/down still change the volume
  if (field && !((e.key === 'ArrowUp' || e.key === 'ArrowDown') && field.tagName === 'INPUT' && !field.value)) return;
  const k = e.key.toLowerCase();
  if (k === ' ' || k === 'k') { e.preventDefault(); togglePlay(); }
  else if (k === 'f') { if (theaterSvc()) theaterPost({ wpTheater: 'fullscreen' }); else toggleFullscreen(); }
  else if (k === 'm') { M.muted = !M.muted; if (player.autoMuted) unblock(); scheduleUi(); }
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    // holding the key down repeats, but at most 5 skips a second
    if (e.repeat && S._lastSkipKey && performance.now() - S._lastSkipKey < 200) return;
    S._lastSkipKey = performance.now();
    seekBy(e.key === 'ArrowLeft' ? -10 : 10);
    return; // just skip: the "+10 s" message is enough, no need to bring up the controls
  }
  else if (e.key === 'ArrowUp') { e.preventDefault(); changeVolume(0.05); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); changeVolume(-0.05); }
  else if (e.key === 'Enter') {
    e.preventDefault();
    if (isFs() || room.classList.contains('no-sidebar')) openQuickChat();
    else { setTab('chat'); $('#chatInput').focus(); }
  }
  poke();
});

// ---------------------------------------------------------------- camera / mic
const localPreview = new MediaStream();
async function startLocal(kind) {
  if (!(isHost || S.perms.camera)) return noPerm('camera');
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast(window.isSecureContext ? 'This browser doesn\'t support camera or mic here.' : 'Webcams need the secure link. Ask the host to switch the invite to "Secure · webcams on" and send it again.', { kind: 'error', timeout: 7000 });
    return;
  }
  try {
    const constraints = kind === 'video'
      ? { video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24, max: 30 } } }
      : { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    const track = stream.getTracks()[0];
    track.addEventListener('ended', () => stopLocal(kind));
    await mesh.setLocalTrack(kind, track);
    if (kind === 'video') S.cam = true; else S.mic = true;
    if (kind === 'audio' && !S._headphoneTip) { S._headphoneTip = true; toast('Tip: wear headphones so the movie sound doesn\'t echo into your mic.', { timeout: 6000 }); }
  } catch (err) {
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    toast(denied ? `Your browser blocked the ${kind === 'video' ? 'camera' : 'microphone'}. Allow it in the address bar and try again.` : `Couldn't start your ${kind === 'video' ? 'camera' : 'microphone'} (${err && err.name}).`, { kind: 'error', timeout: 6000 });
  }
  afterLocalChange();
}
async function stopLocal(kind) {
  if (!mesh) return;
  await mesh.setLocalTrack(kind, null);
  if (kind === 'video') S.cam = false; else S.mic = false;
  afterLocalChange();
}
function afterLocalChange() {
  conn.send({ type: 'media', cam: S.cam, mic: S.mic });
  $('#camBtn').innerHTML = icon(S.cam ? 'cam' : 'cam-off');
  $('#micBtn').innerHTML = icon(S.mic ? 'mic' : 'mic-off');
  $('#camBtn').classList.toggle('live', S.cam);
  $('#micBtn').classList.toggle('live', S.mic);
  renderCams();
}
$('#camBtn').addEventListener('click', () => (S.cam ? stopLocal('video') : startLocal('video')));
$('#micBtn').addEventListener('click', () => (S.mic ? stopLocal('audio') : startLocal('audio')));

// Camera tiles float over the movie. Drag a tile to move it, drag its corner to resize it,
// double-click it to put it back. Each viewer arranges their own screen; it's remembered.
const tiles = new Map();
let camLayout = store.get('wp.camLayout', {});
const layoutKey = id => (id === clientId ? 'self' : id);
const MARGIN = 12, GAP = 8;

function defaultTileWidth() { return Math.min(stage.clientWidth < 700 ? 116 : 184, Math.max(90, stage.clientWidth * 0.3)); }

function placeTiles() {
  if (pipWin) return; // in the pop-out window they sit in a grid
  const W = stage.clientWidth, H = stage.clientHeight;
  if (!W || !H) return;
  let slot = 0;
  for (const [id, t] of tiles) {
    const saved = camLayout[layoutKey(id)];
    let w, x, y;
    if (saved) {
      w = Math.max(90, Math.min(W * 0.6, saved.w * W));
      x = saved.x * W; y = saved.y * H;
    } else {
      w = defaultTileWidth();
      const h = w * 9.5 / 16;
      x = W - w - MARGIN;
      y = MARGIN + slot * (h + GAP);
      slot++;
    }
    const h = w * 9.5 / 16;
    x = Math.max(0, Math.min(W - w, x));
    y = Math.max(0, Math.min(H - h, y));
    Object.assign(t.el.style, { width: `${w}px`, left: `${x}px`, top: `${y}px` });
  }
}

function saveTile(id, el) {
  const W = stage.clientWidth, H = stage.clientHeight;
  camLayout[layoutKey(id)] = { x: el.offsetLeft / W, y: el.offsetTop / H, w: el.offsetWidth / W };
  store.set('wp.camLayout', camLayout);
}

function makeDraggable(id, el) {
  let mode = null, sx = 0, sy = 0, ox = 0, oy = 0, ow = 0;
  el.addEventListener('pointerdown', e => {
    if (e.button !== 0 || inPip()) return;
    mode = e.target.closest('.grip') ? 'resize' : 'move';
    sx = e.clientX; sy = e.clientY; ox = el.offsetLeft; oy = el.offsetTop; ow = el.offsetWidth;
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    e.preventDefault(); e.stopPropagation();
  });
  el.addEventListener('pointermove', e => {
    if (!mode) return;
    const W = stage.clientWidth, H = stage.clientHeight;
    if (mode === 'move') {
      const w = el.offsetWidth, h = el.offsetHeight;
      el.style.left = `${Math.max(0, Math.min(W - w, ox + e.clientX - sx))}px`;
      el.style.top = `${Math.max(0, Math.min(H - h, oy + e.clientY - sy))}px`;
    } else {
      const w = Math.max(90, Math.min(W * 0.6, W - ox, ow + e.clientX - sx));
      el.style.width = `${w}px`;
    }
    poke();
  });
  const end = () => { if (!mode) return; mode = null; el.classList.remove('dragging'); saveTile(id, el); };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('dblclick', e => { e.stopPropagation(); delete camLayout[layoutKey(id)]; store.set('wp.camLayout', camLayout); placeTiles(); });
  el.addEventListener('click', e => e.stopPropagation());
}

function renderCams() {
  if (!mesh) return;
  const box = $('#cams');
  const want = [];
  if (S.cam || S.mic) want.push({ id: clientId, name: S.me?.name || S.name, self: true, media: { cam: S.cam, mic: S.mic } });
  for (const [id, p] of S.peers) if (p.media && (p.media.cam || p.media.mic)) want.push({ id, name: p.name, self: false, media: p.media });
  const keep = new Set(want.map(w => w.id));
  let changed = false;
  for (const [id, t] of tiles) if (!keep.has(id)) { t.el.remove(); tiles.delete(id); changed = true; }
  for (const w of want) {
    let t = tiles.get(w.id);
    if (!t) {
      const el = document.createElement('div');
      el.className = 'tile' + (w.self ? ' self' : '');
      el.title = 'Drag to move · drag the corner to resize · double-click to reset';
      el.innerHTML = `<video autoplay playsinline ${w.self ? 'muted' : ''}></video><div class="avatar">${avatar(w.name, '')}</div><div class="label"></div><div class="grip" aria-hidden="true"></div>`;
      box.appendChild(el);
      t = { el, v: el.querySelector('video') };
      tiles.set(w.id, t);
      makeDraggable(w.id, el);
      changed = true;
    }
    const stream = w.self ? localPreview : S.remoteStreams.get(w.id);
    if (w.self) {
      for (const tr of localPreview.getTracks()) localPreview.removeTrack(tr);
      if (mesh.local.video) localPreview.addTrack(mesh.local.video);
    }
    if (stream && t.v.srcObject !== stream) { t.v.srcObject = stream; t.v.play().catch(() => {}); }
    t.el.querySelector('.avatar').hidden = !!w.media.cam;
    t.v.style.visibility = w.media.cam ? 'visible' : 'hidden';
    t.el.querySelector('.label').innerHTML = `${icon(w.media.mic ? 'mic' : 'mic-off')}<span>${esc(w.self ? 'You' : w.name)}</span>`;
  }
  if (changed) placeTiles();
}
if (window.ResizeObserver) new ResizeObserver(() => placeTiles()).observe(stage);

// ---------------------------------------------------------------- people
function renderPeople() {
  renderBadges();
  const el = $('#peopleList');
  if (!el) return;
  const pending = S.people.filter(p => !p.admitted);
  const here = S.people.filter(p => p.admitted);
  let html = '';
  if (isHost && pending.length) {
    html += `<div class="pending-box"><div class="section-label" style="margin-top:0">Waiting to join</div>` + pending.map(p => `
      <div class="person"><div class="person-top">${avatar(p.name)}<div class="nm"><span>${esc(p.name)}</span></div>
      <div class="icons"><button class="btn sm primary" data-admit="${p.id}">Let in</button><button class="btn sm" data-deny="${p.id}">Deny</button></div></div></div>`).join('') + '</div>';
  }
  const guests = here.filter(p => p.role !== 'host');
  html += `<div class="section-label"><span>Here now · ${here.length}</span>${isHost ? `<button class="btn sm ${S.settings.locked ? 'primary' : ''}" data-lock>${S.settings.locked ? 'Room locked · unlock' : 'Lock room'}</button>` : ''}</div>`;
  if (isHost && guests.length > 1) {
    html += `<div class="bulk"><button class="btn sm" data-all="playback" data-v="1">Everyone can control</button><button class="btn sm" data-all="playback" data-v="0">Only I control</button></div>`;
  }
  for (const p of here) {
    const me = p.id === clientId;
    const st = p.status || {};
    const sub = [];
    if (isHost) {
      if (st.error === 98) sub.push('<span class="bad">Sound only: can\'t show the picture</span>');
      else if (st.error) sub.push('<span class="bad">Can\'t play the video</span>');
      else if (st.buffering) sub.push('<span class="bad">Buffering</span>');
      else if (st.blocked) sub.push('<span class="bad">Needs to click play</span>');
      else if (S.movie && st.loaded) sub.push('<span class="good">In sync</span>');
      else if (S.movie && !st.stale) sub.push('Loading…');
      if (S.movie && st.loaded && st.ahead != null) sub.push(`${Math.round(st.ahead)}s buffered`);
      if (S.movie && p.role !== 'host' && p.mbps > 0.3) sub.push(`${p.mbps} Mbps`);
      if (S.movie && st.loaded && Math.abs(st.drift || 0) > 60 && !st.buffering) sub.push(`${st.drift > 0 ? '+' : ''}${st.drift} ms`);
      if (st.dev && !me) sub.push(esc(st.dev));
      // "stalled 3×": this person's movie ran out of data 3 times (only counted for your own movie files)
      if (S.movie && st.stalls > 0 && !me) sub.push(`<span class="${st.stalls >= 3 ? 'bad' : ''}" title="Times their video ran out of data and had to wait">stalled ${st.stalls}×</span>`);
    } else if (st.buffering) sub.push('<span class="bad">Buffering</span>');
    // the host gets a plain-language reason when someone keeps stalling
    let why = '';
    if (isHost && p.role !== 'host' && S.movie && kindOf(S.movie) === 'file' && (st.stalls >= 3 || st.noWait)) {
      const need = S.movie.mbps || 0;
      const phone = /iPhone|iPad|phone|tablet/i.test(st.dev || '');
      if (need && p.mbps > 0.3 && p.mbps < need * 0.85) why = `Their connection can't keep up: this movie needs ${need} Mbps and they're getting ${p.mbps}. A "Compress for streaming" copy (Library → Options) fixes this.`;
      else if (phone) why = `Their ${esc(st.dev)} keeps running dry even though the speed looks fine. Phones and tablets buffer only a few seconds ahead and struggle with big files; a "Compress for streaming" copy (Library → Options) is much easier on them.`;
      else why = `They keep running dry even though the speed looks fine. Ask them to close other tabs and downloads, or prepare a "Compress for streaming" copy (Library → Options).`;
      if (st.noWait) why += ' The room no longer pauses for them; they catch up on their own.';
    }
    html += `<div class="person" data-id="${p.id}"><div class="person-top">${avatar(p.name)}
      <div style="min-width:0"><div class="nm"><span>${esc(p.name)}${me ? ' (you)' : ''}</span>${p.role === 'host' ? '<span class="host-tag">HOST</span>' : ''}</div>
      ${sub.length ? `<div class="sub">${sub.join('<span>·</span>')}</div>` : ''}
      ${why ? `<div class="sub why">${why}</div>` : ''}
      ${isHost && p.ip ? `<div class="sub" title="The internet address this person is connecting from">from ${esc(p.ip)}</div>` : ''}</div>
      <div class="icons">${p.media?.cam ? icon('cam', 'on') : ''}${p.media?.mic ? icon('mic', 'on') : ''}${me ? `<button class="btn sm ghost" data-rename>Rename</button>` : ''}</div></div>`;
    if (isHost && p.role !== 'host') {
      const perm = (k, label) => `<label class="perm"><input type="checkbox" class="switch" data-perm="${k}" data-client="${p.id}" ${p.perms?.[k] ? 'checked' : ''}>${label}</label>`;
      html += `<div class="perm-grid">${perm('playback', 'Control')}${perm('chat', 'Chat')}${perm('react', 'React')}${perm('camera', 'Cam & mic')}</div>
        <div class="person-actions"><button class="btn sm danger-ghost" data-kick="${p.id}">Remove</button></div>`;
    }
    html += '</div>';
  }
  if (!isHost) {
    const mine = [];
    if (!S.perms.playback) mine.push('play/pause');
    if (!S.perms.chat) mine.push('chat');
    if (!S.perms.camera) mine.push('camera');
    if (mine.length) html += `<p class="fine" style="margin-top:12px">The host has turned off: ${mine.join(', ')}.${!S.perms.playback ? ' <button class="btn sm" data-request>Ask for control</button>' : ''}</p>`;
  }
  if (isHost && !guests.length) html += `<p class="fine" style="margin-top:12px">No one else is here yet. <button class="btn sm" data-invite>Invite people</button></p>`;
  el.innerHTML = html;
}

function renderObservatory() {
  if (!isHost) return;
  const el = $('#observatory');
  if (!el) return;
  const obs = S.observatory || { confidence: null, timeline: [], recommendations: [] };
  if (!S.movie || obs.confidence == null) {
    el.innerHTML = `<div class="obs-empty"><b>Sync Observatory</b><p class="fine">Start a movie or streaming service to see live room timing.</p></div>`;
    return;
  }
  const tone = value => value >= 85 ? 'good' : value >= 65 ? 'warn' : 'bad';
  const score = Math.max(0, Math.min(100, Number(obs.confidence) || 0));
  const people = S.people.filter(p => p.admitted);
  const participants = people.map(p => {
    const st = p.status || {};
    const rtt = Math.max(0, Number(st.rtt) || 0);
    const health = Math.max(0, Math.min(100, Number(st.health) || 0));
    const drift = Number(st.drift) || 0;
    const ring = Math.min(360, rtt / 600 * 360);
    const latencyTone = rtt <= 120 ? 'good' : rtt <= 280 ? 'warn' : 'bad';
    const corrections = (st.corrections || []).slice(-6).map(c => `<span class="obs-correction ${esc(c.type)}" title="${esc(`${c.type} correction at ${new Date(c.at).toLocaleTimeString()}`)}">${esc(c.type)} ${c.drift > 0 ? '+' : ''}${Math.round(c.drift || 0)}ms</span>`).join('');
    return `<article class="obs-person">
      <div class="latency-ring ${latencyTone}" style="--latency:${ring}deg"><b>${rtt || '—'}</b><small>ms RTT</small></div>
      <div class="obs-person-main"><div class="obs-person-name">${esc(p.name)}${p.id === clientId ? ' <span>(you)</span>' : ''}</div>
        <div class="obs-metrics"><span><b>${drift > 0 ? '+' : ''}${Math.round(drift)}</b> ms drift</span><span><b>${Math.round(health)}</b>% buffer</span><span><b>${Number(st.rate || 1).toFixed(2)}×</b> rate</span></div>
        <div class="obs-health"><i style="width:${health}%"></i></div>
        <div class="obs-corrections">${corrections || '<span class="fine">No corrections needed</span>'}</div>
      </div></article>`;
  }).join('');
  const duration = Number(S.movie.duration) || 0;
  const events = (obs.timeline || []).slice(-40);
  const firstAt = events.length ? events[0].at : Date.now() - 300000;
  const timeSpan = Math.max(1, Date.now() - firstAt);
  const markers = events.map(event => {
    const pct = duration ? Math.max(0, Math.min(100, Number(event.position) / duration * 100)) : Math.max(0, Math.min(100, (event.at - firstAt) / timeSpan * 100));
    return `<i class="${event.type}" style="left:${pct}%" title="${esc(`${event.name} ${event.type === 'stall' ? 'stalled' : 'recovered'} at ${fmtTime(event.position)}`)}"></i>`;
  }).join('');
  const recent = events.slice(-4).reverse().map(event => `<li><span class="obs-event ${event.type}"></span>${esc(event.name)} ${event.type === 'stall' ? 'stalled' : 'recovered'} <time>${fmtTime(event.position)}</time></li>`).join('');
  const recommendations = (obs.recommendations || []).map(r => `<div class="obs-recommendation ${r.level === 'urgent' ? 'urgent' : ''}">${icon('film')}<span>${esc(r.text)}</span></div>`).join('');
  el.innerHTML = `<div class="obs-head"><div class="confidence-ring ${tone(score)}" style="--score:${score * 3.6}deg"><b>${score}</b><small>sync confidence</small></div><div><h3>Sync Observatory</h3><p>Live timing across ${people.length} participant${people.length === 1 ? '' : 's'}</p></div></div>
    ${recommendations ? `<div class="obs-recommendations">${recommendations}</div>` : ''}
    <div class="section-label">Participants</div>${participants || '<p class="fine">Waiting for player telemetry…</p>'}
    <div class="section-label">Room timeline</div><div class="obs-timeline"><span></span>${markers}</div>${recent ? `<ul class="obs-events">${recent}</ul>` : '<p class="fine">No stalls. The room has been steady.</p>'}
    <p class="obs-privacy">Live only · metrics stay in memory and are erased when the room closes.</p>`;
}
$('#peopleList').addEventListener('click', e => {
  const t = e.target;
  if (t.matches('[data-admit]')) conn.send({ type: 'admit', clientId: t.dataset.admit });
  else if (t.matches('[data-deny]')) conn.send({ type: 'deny', clientId: t.dataset.deny });
  else if (t.matches('[data-kick]')) {
    const p = S.people.find(x => x.id === t.dataset.kick);
    if (p && confirm(`Remove ${p.name} from the party? They won't be able to rejoin with this link.`)) conn.send({ type: 'kick', clientId: p.id });
  } else if (t.matches('[data-all]')) conn.send({ type: 'set-all-perm', perm: t.dataset.all, value: t.dataset.v === '1' });
  else if (t.matches('[data-rename]')) {
    const n = prompt('Your name', S.me?.name || '');
    if (n && n.trim()) { S.name = n.trim().slice(0, 32); store.set(isHost ? 'wp.hostName' : 'wp.name', S.name); conn.send({ type: 'rename', name: S.name }); }
  } else if (t.matches('[data-request]')) { conn.send({ type: 'request-control' }); toast('Asked the host for control', { timeout: 2000 }); }
  else if (t.matches('[data-invite]')) openInvite();
  else if (t.matches('[data-lock]')) conn.send({ type: 'settings', settings: { locked: !S.settings.locked } });
});
$('#peopleList').addEventListener('change', e => {
  const t = e.target;
  if (t.matches('[data-perm]')) conn.send({ type: 'set-perm', clientId: t.dataset.client, perm: t.dataset.perm, value: t.checked });
});

// ---------------------------------------------------------------- host: API
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key, ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------------------------------------------------------------- host: invite
let infoTimer = null;
function refreshInfoSoon() { clearTimeout(infoTimer); infoTimer = setTimeout(refreshInfo, 300); }
async function refreshInfo() {
  if (!isHost) return;
  try { S.info = await api('/api/info'); } catch { return; }
  renderInvite();
  renderSettings();
  renderLibrary();
  renderServicePanel();
  if (S.info.updatePending && !S.updateWarned) {
    S.updateWarned = true;
    toast('An update is downloaded but not installed. Close the Watch Party window, then double-click "refresh.bat" (not WatchParty.exe).', { kind: 'error', timeout: 15000 });
  }
}
function netSummary(i) {
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
  const searching = n.status === 'searching' || n.status === 'idle';
  $('#inviteQr').innerHTML = i.qr || (searching ? '<div class="spinner"></div>' : 'No public link yet');
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

// ---------------------------------------------------------------- host: settings
function renderSettings() {
  if (!isHost) return;
  const s = S.settings || {};
  for (const el of $$('[data-setting]')) el.checked = !!s[el.dataset.setting];
  for (const el of $$('[data-default]')) el.checked = !!(s.defaults && s.defaults[el.dataset.default]);
  const up = $('#uploadInput');
  if (S.info && document.activeElement !== up) up.value = S.info.uploadMbps || '';
  const mg = $('#maxGuestsInput');
  if (document.activeElement !== mg) mg.value = s.maxGuests || 8;
  const safariUrl = $('#safariExtensionUrl');
  if (document.activeElement !== safariUrl) safariUrl.value = s.safariExtensionUrl || S.info?.settings?.safariExtensionUrl || '';
  const i = S.info;
  const box = $('#netBox');
  if (!i || !box) return;
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
$('#safariExtensionSave').addEventListener('click', async () => {
  const button = $('#safariExtensionSave');
  button.disabled = true;
  try {
    S.info = await api('/api/settings', { method: 'POST', body: JSON.stringify({ safariExtensionUrl: $('#safariExtensionUrl').value }) });
    S.settings = S.info.settings || S.settings;
    toast(S.settings.safariExtensionUrl ? 'Apple install link saved.' : 'Apple install link removed.', { timeout: 2500 });
    renderSettings(); renderServicePanel();
  } catch (e) { toast(e.message, { kind: 'error', timeout: 5000 }); button.disabled = false; }
});
$('#rotateBtn').addEventListener('click', () => { if (confirm('Make a new invite link? Everyone currently watching will be disconnected and will need the new link.')) conn.send({ type: 'rotate-link' }); });

// ---------------------------------------------------------------- host: library
let libTimer = null;
function loadLibrarySoon() { clearTimeout(libTimer); libTimer = setTimeout(loadLibrary, 250); }
async function loadLibrary() {
  if (!isHost) { if (canControl()) conn.send({ type: 'lib-list' }); return; } // the answer arrives as 'library'
  try { S.library = await api('/api/library'); } catch (e) { return; }
  const ta = $('#foldersInput');
  if (document.activeElement !== ta) ta.value = (S.library.folders || []).join('\n');
  $('#foldersSummary').textContent = S.library.folders.length ? `Movie folders (${S.library.folders.length})` : 'Add your movie folders';
  if (!S.library.folders.length) $('#foldersBox').open = true;
  renderLibrary();
}

function guestCount() { return Math.max(1, S.people.filter(p => p.admitted && p.role !== 'host').length); }

function movieChips(it) {
  const i = it.info;
  const c = [];
  if (!i) return '';
  const v = i.video || {};
  const r = resLabel(v.width, v.height);
  if (r) c.push(`<span class="chip">${r}</span>`);
  if (v.hdr) c.push(`<span class="chip hdr">${esc(v.hdr)}</span>`);
  if (v.codec) c.push(`<span class="chip">${esc(codecLabel(v.codec))}${v.bitDepth > 8 ? ' 10-bit' : ''}</span>`);
  const a = i.audios.find(x => x.index === i.defaultAudioIndex);
  if (a) c.push(`<span class="chip">${esc(a.label)}</span>`);
  if (i.duration) c.push(`<span class="chip">${fmtDur(i.duration)}</span>`);
  c.push(`<span class="chip">${esc(it.sizeLabel)}</span>`);
  if (i.bitrateMbps) c.push(`<span class="chip">${i.bitrateMbps} Mbps</span>`);
  return c.join('');
}

function prepFormHtml(it) {
  const i = it.info;
  const o = S.prepOpts.get(it.id) || {};
  const must = i.plan.mode === 'transcode';
  const enc = S.info?.encoderLabel || (isHost ? 'your GPU' : 'the host\'s graphics card');
  const audioOpts = i.audios.map(a => `<option value="${a.index}" ${String(o.audioIndex ?? i.defaultAudioIndex) === String(a.index) ? 'selected' : ''}>${esc([a.lang, a.label, a.title].filter(Boolean).join(' · '))}</option>`).join('');
  const compress = !!o.compress;
  const hls = o.hls !== false;
  const target = o.targetMbps || (i.video.width > 1920 ? 25 : 12);
  const textSubs = i.subs.filter(s => s.text).length;
  const imgSubs = i.subs.filter(s => !s.text).length;
  return `<div class="prep-form" data-form="${it.id}">
    ${i.audios.length > 1 ? `<label class="opt">Audio track<select data-o="audioIndex">${audioOpts}</select></label>` : ''}
    ${(() => { const a = i.audios.find(x => String(x.index) === String(o.audioIndex ?? i.defaultAudioIndex)) || i.audios[0]; return a && a.channels > 2; })() ? `<div class="opt"><div class="seg">
      <label><input type="radio" name="am-${it.id}" data-o="audioMode" value="surround" ${o.audioMode !== 'stereo' ? 'checked' : ''}>Surround (5.1)</label>
      <label><input type="radio" name="am-${it.id}" data-o="audioMode" value="stereo" ${o.audioMode === 'stereo' ? 'checked' : ''}>Stereo</label></div></div>` : ''}
    <div class="opt"><div class="seg">
      <label><input type="radio" name="vm-${it.id}" data-o="compress" value="0" ${!compress ? 'checked' : ''}>${must ? 'Re-encode (high quality)' : 'Original quality'}</label>
      <label><input type="radio" name="vm-${it.id}" data-o="compress" value="1" ${compress ? 'checked' : ''}>Compress for streaming</label></div>
      <div class="hint" style="margin-top:6px">${compress
        ? `Re-encodes the video with ${esc(enc)} so it needs less upload. At 20–25 Mbps, 4K still looks close to the original.`
        : must ? `This video format has to be re-encoded with ${esc(enc)}.` : 'Video is copied bit-for-bit. Viewers get exactly what you have.'}</div></div>
    ${compress ? `<label class="opt">Target bitrate<select data-o="targetMbps">${[8, 12, 16, 20, 25, 30, 40].map(n => `<option value="${n}" ${n === +target ? 'selected' : ''}>${n} Mbps${n <= 12 ? ' (1080p-ish)' : n >= 30 ? ' (near original)' : ''}</option>`).join('')}</select></label>` : ''}
    <label class="check-row"><input type="checkbox" data-o="hls" ${hls ? 'checked' : ''}><span><b>Optimize for Safari, iPhone and iPad</b><br>Creates segmented HLS media for steadier seeking and recovery on Apple devices. Other browsers still use the direct file.</span></label>
    <div class="hint">${textSubs ? `${textSubs} text subtitle track${textSubs > 1 ? 's' : ''} will be included.` : 'No text subtitles in this file.'}${imgSubs ? ` ${imgSubs} image subtitle track${imgSubs > 1 ? 's' : ''} (PGS) can't be shown in browsers.` : ''}</div>
    <div class="hint">The prepared copy is deleted when Watch Party stops, so it doesn't fill up your disk. Prepare it again next time (copying takes a few minutes, compressing longer).</div>
    <div class="row end" style="margin-top:0"><button class="btn sm" data-act="closeprep" data-id="${it.id}">Cancel</button><button class="btn sm primary" data-act="prepare" data-id="${it.id}">Start</button></div>
  </div>`;
}

function renderLibrary() {
  if (!isHost && !canControl()) return;
  const list = $('#libList');
  const L = S.library;
  if (!L) { list.innerHTML = '<div class="empty-lib"><div class="spinner"></div></div>'; return; }
  if (!L.folders.length) { list.innerHTML = `<div class="empty-lib">${isHost ? 'Add the folder where your movie files are, and they\'ll show up here.' : 'The host hasn\'t added any movies yet.'}</div>`; return; }
  const q = $('#libSearch').value.trim().toLowerCase();
  const items = L.items.filter(it => !q || it.title.toLowerCase().includes(q) || it.rel.toLowerCase().includes(q));
  if (!items.length) { list.innerHTML = `<div class="empty-lib">${L.scanning ? 'Scanning your folders…' : q ? 'No matches.' : 'No movie files found in those folders (.mkv, .mp4, .m2ts…).'}</div>`; return; }
  const upload = S.info?.uploadMbps || 0;
  const viewers = guestCount();
  list.innerHTML = items.map(it => {
    const i = it.info;
    const current = S.movie && S.movie.id === it.id;
    let status = '', acts = '', why = '', warn = '';
    if (it.job && ['queued', 'running'].includes(it.job.state)) {
      status = `<div class="progress"><div style="width:${it.job.percent.toFixed(1)}%"></div></div>
        <div class="progress-meta"><span>${esc(it.job.label)}${it.job.state === 'queued' ? ' · queued' : ''}</span><span data-pm>${it.job.percent.toFixed(0)}%${it.job.speed ? ` · ${it.job.speed.toFixed(1)}×` : ''}${it.job.eta ? ` · ${fmtEta(it.job.eta)}` : ''}</span></div>`;
      acts = `<button class="btn sm" data-act="cancel" data-id="${it.id}">Cancel</button>`;
    } else if (it.job && it.job.state === 'error') {
      status = `<div class="warnline" style="color:#ff8a8a">Prepare failed: ${esc(it.job.error)}</div>`;
    } else if (it.job && it.job.state === 'done') {
      status = `<div class="warnline" style="color:var(--ok)">Ready to play.</div>`;
    }
    if (!i && !it.probeError) {
      status = status || '<div class="fine">Reading file info…</div>';
    } else if (it.probeError) {
      status = `<div class="warnline" style="color:#ff8a8a">Couldn't read this file: ${esc(it.probeError)}</div>`;
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
          ? `<div class="fine">Optimized for Safari, iPhone and iPad · ${esc(it.prepared.sizeLabel)}</div>`
          : `<div class="fine">Prepared copy · ${esc(it.prepared.sizeLabel)} · ${it.prepared.bitrateMbps} Mbps · ${esc(it.prepared.audioLabel || '')}${it.prepared.compressed ? ' · compressed' : ''}${it.prepared.hls ? ' · Safari HLS' : ''}</div>`);
      } else if (plan.mode === 'unsupported') {
        why = `<ul class="why">${plan.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>`;
      } else {
        if (it.stalePrepared) status = `<div class="warnline">The copy made by the older version shows a black screen (Dolby Vision). Prepare it again to fix it; the old copy is replaced.</div>`;
        why = `<ul class="why">${plan.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>`;
        const est = plan.mode === 'remux' ? ` (~${Math.max(1, Math.round(it.size / 120e6 / 60))} min)` : '';
        if (!S.prepOpen.has(it.id)) acts = `<button class="btn sm primary" data-act="quickprep" data-id="${it.id}">Prepare${est}</button><button class="btn sm ghost" data-act="openprep" data-id="${it.id}">Options</button>`;
      }
      const mbps = (it.prepared && it.prepared.bitrateMbps) || i.bitrateMbps;
      if (upload && mbps && mbps * viewers > upload * 0.85) {
        warn = `<div class="warnline">This file is ${mbps} Mbps. ${viewers} viewer${viewers > 1 ? 's' : ''} need about ${Math.round(mbps * viewers)} Mbps of upload, and you have ${upload}. Use "Compress for streaming" in Options.</div>`;
      }
      if (i.plan.mode === 'direct' && !it.prepared) {
        const ts = i.subs.filter(s => s.text).length;
        if (ts) status = status || `<div class="fine">Has ${ts} subtitle track${ts > 1 ? 's' : ''}. Use Options to extract ${ts > 1 ? 'them' : 'it'}.</div>`;
      }
    }
    return `<div class="movie ${current ? 'current' : ''}" data-movie="${it.id}">
      <div class="movie-top"><div style="min-width:0;flex:1"><div class="mt">${esc(it.title)}</div><div class="mf" title="${esc(it.rel)}">${esc(it.rel)}</div></div></div>
      <div class="chips">${movieChips(it)}</div>
      ${why}${status}${warn}
      ${acts ? `<div class="acts">${acts}</div>` : ''}
      ${S.prepOpen.has(it.id) && i ? prepFormHtml(it) : ''}
    </div>`;
  }).join('');
}

function renderLibraryCurrent() { if ((isHost || canControl()) && S.library) renderLibrary(); }

function updateJob(id, job) {
  const it = S.library && S.library.items.find(x => x.id === id);
  if (it) it.job = job;
  const card = document.querySelector(`[data-movie="${id}"]`);
  const bar = card && card.querySelector('.progress > div');
  if (bar) {
    bar.style.width = job.percent.toFixed(1) + '%';
    const pm = card.querySelector('[data-pm]');
    if (pm) pm.textContent = `${job.percent.toFixed(0)}%${job.speed ? ` · ${job.speed.toFixed(1)}×` : ''}${job.eta ? ` · ${fmtEta(job.eta)}` : ''}`;
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
$('#libList').addEventListener('change', e => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  const id = form.dataset.form;
  const o = S.prepOpts.get(id) || {};
  const k = e.target.dataset.o;
  if (k === 'compress') o.compress = e.target.value === '1';
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
      case 'quickprep': if (!isHost) { conn.send({ type: 'lib-prepare', id, opts: {} }); break; } await api(`/api/prepare/${id}`, { method: 'POST', body: '{}' }); break;
      case 'prepare': {
        const o = S.prepOpts.get(id) || {};
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

// ---------------------------------------------------------------- host: streaming links
$('#streamGo').addEventListener('click', () => {
  const url = $('#streamUrl').value.trim();
  if (!url) return toast('Paste the link of a movie or episode first.', { timeout: 2500 });
  conn.send({ type: 'select-url', url, inTabs: $('#streamInTabs').checked });
  $('#streamUrl').value = '';
});
$('#streamUrl').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#streamGo').click(); } });

// ---------------------------------------------------------------- host: a custom site
// Any website with a video. It opens inside everyone's Watch Party window (the extension's "watch
// here" window) and only the host controls it: the host presses play, everyone plays, in sync.
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

// ---------------------------------------------------------------- the pop-out party
// A small always-on-top window (Chrome, Edge, Brave on a computer) with the cameras, chat,
// reactions and play controls. It floats over Netflix, Prime Video and the others, even in
// fullscreen, so you never have to leave the video to see the party.
function inPip() { return !!pipWin; }
const canPip = () => 'documentPictureInPicture' in window;
async function togglePip(opts = {}) {
  if (pipWin) { if (!opts.keep) pipWin.close(); return; }
  if (!canPip()) { if (!opts.quiet) toast('The pop-out party needs Chrome, Edge or Brave on a computer.', { timeout: 4000 }); return; }
  try {
    pipWin = await window.documentPictureInPicture.requestWindow({ width: 360, height: 520 });
  } catch (e) { if (!opts.quiet) toast('Could not open the pop-out party.', { kind: 'error' }); pipWin = null; return; }
  const doc = pipWin.document;
  for (const ss of [...document.styleSheets]) {
    try { const st = doc.createElement('style'); st.textContent = [...ss.cssRules].map(r => r.cssText).join('\n'); doc.head.appendChild(st); } catch { /* cross-origin sheet */ }
  }
  const svg = document.querySelector('body > svg');
  if (svg) doc.body.appendChild(svg.cloneNode(true));
  doc.body.className = 'pip-body';
  doc.title = 'Watch Party';
  const cams = $('#cams');
  doc.body.appendChild(cams);
  cams.querySelectorAll('video').forEach(v => v.play().catch(() => {}));
  doc.body.insertAdjacentHTML('beforeend', `
    <div class="pop-note" id="popNote" hidden></div>
    <div class="pop-ctrl">
      <button class="ctrl" data-pop="toggle" title="Play / pause" aria-label="Play or pause">${icon('play')}</button>
      <button class="ctrl" data-pop="back" title="Back 10 s" aria-label="Back 10 seconds">${icon('back10')}</button>
      <button class="ctrl" data-pop="fwd" title="Forward 10 s" aria-label="Forward 10 seconds">${icon('fwd10')}</button>
      <span class="pop-reacts" id="popReacts"></span>
      <button class="ctrl" data-pop="cam" title="Camera" aria-label="Camera">${icon('cam-off')}</button>
      <span class="time" id="popTime"></span>
    </div>
    <div class="pop-chat" id="popChat"></div>
    <form class="pop-form" id="popForm"><input id="popInput" maxlength="500" placeholder="Say something…" autocomplete="off"><button class="btn sm primary" type="submit">Send</button></form>`);
  doc.getElementById('popReacts').innerHTML = (S.reactions || []).slice(0, 5).map(r => `<button type="button" data-emoji="${esc(r)}">${esc(r)}</button>`).join('');
  doc.body.addEventListener('click', e => {
    const em = e.target.closest('[data-emoji]');
    if (em) { if (isHost || S.perms.react) conn.send({ type: 'react', emoji: em.dataset.emoji }); else noPerm('react'); return; }
    const b = e.target.closest('[data-pop]');
    if (!b) return;
    if (b.dataset.pop === 'toggle') togglePlay();
    else if (b.dataset.pop === 'back') seekBy(-10);
    else if (b.dataset.pop === 'fwd') seekBy(10);
    else if (b.dataset.pop === 'cam') $('#camBtn').click();
  });
  doc.getElementById('popForm').addEventListener('submit', e => { e.preventDefault(); sendChat(doc.getElementById('popInput')); });
  doc.addEventListener('keydown', e => {
    if (e.target.closest('input')) return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft') seekBy(-10);
    else if (e.key === 'ArrowRight') seekBy(10);
  });
  $('#pipBtn').classList.add('live');
  popRender(true);
  pipWin.addEventListener('pagehide', () => {
    stage.appendChild(cams);
    cams.querySelectorAll('video').forEach(v => v.play().catch(() => {}));
    pipWin = null;
    $('#pipBtn').classList.remove('live');
    placeTiles();
  });
}
let popChatKey = '';
function popRender(force) {
  if (!pipWin) return;
  const doc = pipWin.document;
  const t = doc.getElementById('popTime');
  if (!t) return;
  const playing = !!(S.state && S.state.playing);
  t.textContent = S.movie ? `${fmtTime(localPos())} / ${fmtTime(S.movie.duration || M.duration || 0)}` : '';
  const tb = doc.querySelector('[data-pop="toggle"]');
  const want = playing ? 'pause' : 'play';
  if (tb.dataset.icon !== want) { tb.dataset.icon = want; tb.innerHTML = icon(want); }
  const cb = doc.querySelector('[data-pop="cam"]');
  cb.classList.toggle('on', !!S.cam);
  const note = doc.getElementById('popNote');
  let n = '';
  if (S.state && S.state.waiting) { const who = (S.state.waitingFor || []).filter(x => x !== S.me?.name); n = who.length ? `Waiting for ${who.join(', ')}…` : 'Getting everyone in sync…'; }
  else if (remote && remote.st && remote.st.ad) n = 'An ad is playing in your tab. The room waits.';
  note.hidden = !n; note.textContent = n;
  const key = S.chatLog.length + ':' + (S.chatLog.length ? S.chatLog[S.chatLog.length - 1].ts : 0);
  if (force || key !== popChatKey) {
    popChatKey = key;
    const list = doc.getElementById('popChat');
    list.innerHTML = S.chatLog.slice(-60).map(c => c.system ? `<div class="m sys">${esc(c.text)}</div>` : `<div class="m"><b>${esc(c.name)}</b>${esc(c.text)}</div>`).join('');
    list.scrollTop = list.scrollHeight;
  }
}
setInterval(() => popRender(false), 500);
$('#pipBtn').addEventListener('click', () => togglePip());

// handy for troubleshooting from the browser console
window.__wp = { S, get player() { return player; }, get conn() { return conn; }, get mesh() { return mesh; }, get remote() { return remote; }, pipDoc: () => pipWin && pipWin.document, clientId };


// ---------------------------------------------------------------- the party inside the streaming tab
// When you watch on Netflix, Prime Video and the others, the extension shows this party in Chrome's
// side panel right next to the video: chat, reactions, people, cameras and the play controls.
// This page stays the one that's connected to the room; the panel is just a view of it.
const dock = { open: false, timer: null, last: '', pc: null, rtcKey: '', cams: [], pendingIce: [] };

function dockSnapshot() {
  const m = S.movie;
  const peopleHere = (S.people || []).filter(p => p.admitted);
  return {
    me: { name: S.me?.name || S.name || '', host: isHost },
    movie: m ? { title: m.title || '', service: kindOf(m) === 'service' ? serviceName(m) : kindOf(m) === 'youtube' ? 'YouTube' : 'Movie' } : null,
    canControl: canControl(), canChat: isHost || !!S.perms.chat, canReact: isHost || !!S.perms.react, canCam: isHost || !!S.perms.camera,
    reactions: S.reactions || [],
    people: peopleHere.map(p => ({ name: p.name, host: p.role === 'host', me: p.id === clientId, cam: !!(p.media && p.media.cam), mic: !!(p.media && p.media.mic) })),
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
// Snapshots only go out when something changed; the time is sent on its own, twice a second.
// (Timers in a background tab can slow down, so both are also driven by the streaming tab's updates.)
setInterval(() => { dockPush(); dockTime(); dockRtcSync(); }, 500);
let dockTimeAt = 0;
window.addEventListener('message', e => {
  if (e.source !== window || !e.data || e.data.source !== 'wp-ext' || e.data.type !== 'status' || !dock.open) return;
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
    case 'react': if ((S.reactions || []).includes(a.emoji)) conn.send({ type: 'react', emoji: a.emoji }); break;
    case 'cam': $('#camBtn').click(); break;
    case 'mic': $('#micBtn').click(); break;
    default:
  }
  dockPushSoon();
}

// Cameras in the panel: this page sends the camera pictures it already has to the panel over a
// direct connection inside your own browser (nothing extra goes over the internet).
function dockCamItems() {
  const items = [];
  if (S.cam && mesh && mesh.local.video) items.push({ id: clientId, track: mesh.local.video, name: 'You', self: true });
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
    dock.cams.push({ sid: ms.id, name: it.name, self: !!it.self });
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


// ---------------------------------------------------------------- "watch here" window
// Chromium can build a side-by-side theater window. Safari opens a normal top-level player tab so
// streaming sites see the environment they expect and iPhone/iPad can use the toolbar popup.
function enterTheater() {
  if (!remote || !remote.present) return;
  const url = `${location.origin}${location.pathname}#wpcid=${encodeURIComponent(clientId)}&wpname=${encodeURIComponent(S.me?.name || S.name || '')}`;
  remote.post({ type: 'theater', url });
  // this page is replaced by the Watch Party window in a moment; still here after a few seconds = it didn't work
  clearTimeout(enterTheater.timer);
  enterTheater.timer = setTimeout(() => extProblem({ kind: 'theater', error: 'nothing happened' }), 4000);
}
// The extension is installed but isn't answering: say what to do instead of silently doing nothing.
function extProblem(p) {
  if (remote && remote.platform === 'safari') {
    clearTimeout(enterTheater.timer);
    toast(`Watch Party Sync isn't responding${p.error && p.error !== 'stale' ? ` (${p.error})` : ''}. Make sure it is enabled and allowed for this site in Safari Settings, then reload this page.`,
      { kind: 'error', timeout: 30000, actions: [{ label: 'Reload this page', primary: true, run: () => location.reload() }] });
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
const theaterSvc = () => isTheater && kindOf(S.movie) === 'service';
function theaterPost(msg) {
  if (!isTheater) return;
  const origin = (location.ancestorOrigins && location.ancestorOrigins[0]) || '*';
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
  const msg = { wpTheater: 'stage', show, custom: isCustom(), strict: isCustom() && !!S.movie.strict, cover, linked: !!(remote && remote.linked && remote.st), browsing: !!(S.movie && S.movie.browsing), signin: !!(remote && remote.signingIn), current: remote ? canonicalUrl(remote.pageUrl) : '', url: S.movie && S.movie.url, rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } };
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


// ---------------------------------------------------------------- keep phones and tablets awake
// A phone that dims and locks its screen pauses the video. Ask it to stay awake while something plays.
let wakeLock = null;
async function keepAwake(on) {
  if (!('wakeLock' in navigator)) return;
  try {
    if (on && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* not allowed right now (e.g. tab hidden) */ }
}
setInterval(() => keepAwake(!!(S.movie && S.state && (S.state.playing || S.state.waiting) && document.visibilityState === 'visible')), 2000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.movie && S.state && S.state.playing) keepAwake(true); });


// ---------------------------------------------------------------- streaming service tiles
function renderServiceTiles() {
  const grid = $('#svcGrid');
  if (!grid) return;
  const cur = S.movie && S.movie.service;
  grid.innerHTML = Object.entries(SERVICE_NAMES).map(([id, name]) => `<button type="button" class="svc-tile ${cur === id ? 'cur' : ''}" data-svc-tile="${id}" style="--svc:${SERVICE_COLORS[id]}" title="Watch together on ${esc(name)}"><span>${esc(name)}${id === 'youtube' ? '<small>no sign-in, plays here</small>' : ''}</span></button>`).join('');
}
renderServiceTiles();
$('#svcGrid').addEventListener('click', e => {
  const b = e.target.closest('[data-svc-tile]');
  if (!b) return;
  const id = b.dataset.svcTile;
  if (id === 'youtube') { openYouTube(); return; }
  // a guest picking the service the room is already watching: join the title that's on, don't send
  // everyone back to the start page
  if (!isHost && S.movie && kindOf(S.movie) === 'service' && S.movie.service === id && !S.movie.browsing) {
    setTab('chat');
    if (!remote || !remote.present) return; // the panel shows how to add the extension
    if (isTheater) theaterPost({ wpTheater: 'goto', url: S.movie.url });
    else if (!$('#svcNewTab').checked) enterTheater();
    else { togglePip({ keep: true, quiet: true }); remote.openPanel(); remote.openTab(); }
    toast(`Taking you to ${S.movie.title && S.movie.title !== serviceName(S.movie) ? `"${S.movie.title}"` : 'what the room is watching'}…`, { timeout: 3000 });
    return;
  }
  if (!remote || !remote.present) {
    conn.send({ type: 'select-url', url: SERVICE_HOMES[id], browsing: true }); // the panel then shows the install steps
    setTab('chat');
    return;
  }
  conn.send({ type: 'select-url', url: SERVICE_HOMES[id], browsing: true });
  setTab('chat');
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
  if (cb) { cb.checked = store.get('wp.autoSkip', true); cb.addEventListener('change', () => { store.set('wp.autoSkip', cb.checked); dockPush(true); }); }
}

// The room follows the host's streaming tab: when the host's tab starts playing a title whose page
// differs from what the room has, that becomes the room's movie (starting where the host's tab is).
// Guests the host lets control playback can do this too: they pick something on Netflix in their
// own window and the room, the host included, follows them.
// Only a tab that moved on by itself counts: a tab still on the page it was on when the room's title
// changed (someone else picked something) doesn't pull the room back.
let followTimer = null, lastFollowUrl = '', followBase = '';
function maybeFollowTab() {
  if (!(isHost || canControl()) || !remote || !remote.linked || !remote.st) return;
  const m = S.movie;
  if (!m || kindOf(m) !== 'service') return;
  const st = remote.st;
  // On a custom site the video usually plays in a frame inside the page, which can't tell which page
  // it's on: use the page the window shows.
  const pageNow = () => (remote.st && remote.st.url) || (m.service === 'custom' ? remote.pageUrl : '') || '';
  const url = canonicalUrl(pageNow());
  if (!url || url === canonicalUrl(m.url) || url === lastFollowUrl || url === followBase) return;
  if (!(st.dur > 60) || st.ad || st.paused) return; // nothing real is playing yet
  // a home page / browse rows / profile picker / info page plays trailers by itself: never a pick
  if (!isTitlePage(pageNow())) return;
  // someone who just joined (and is still finding their way to the room's title, through "Who's
  // watching?" and the home page) can't move the room; only once they've been on the room's title
  if (!isHost && !m.browsing && !reachedTitle) return;
  if (m.service === 'custom' ? !!serviceOfUrl(url) : serviceOfUrl(url) !== m.service) return; // wandered off to another site
  lastFollowUrl = url;
  clearTimeout(followTimer);
  followTimer = setTimeout(() => {
    if (!remote.st || canonicalUrl(pageNow()) !== url || !(isHost || canControl())) return;
    const msg = { type: 'select-url', url: m.service === 'custom' ? pageNow() : url, follow: true, title: remote.st.title || '', duration: remote.st.dur || 0, position: remote.currentTime, playing: !remote.st.paused || (!!remote.st.hold && !!S.state && !!S.state.playing) };
    conn.send(msg);
  }, 1200);
}
window.addEventListener('message', e => {
  if (e.source !== window || !e.data || e.data.source !== 'wp-ext') return;
  // once the tab has left the page it was on when someone else changed the title, anything it plays
  // (even that same title again) is a new choice
  const u = e.data.type === 'page' ? e.data.url : e.data.type === 'status' && e.data.st ? e.data.st.url : '';
  if (followBase && u && canonicalUrl(u) !== followBase) followBase = '';
  if (e.data.type === 'status') maybeFollowTab();
});
// Guests: when the room's title changes on the service they have open, their tab is taken there.
let lastMovieUrl = '';
function bringAlong(movie) {
  if (!movie || kindOf(movie) !== 'service') { lastMovieUrl = ''; return; }
  const prev = lastMovieUrl;
  lastMovieUrl = movie.url;
  if (prev !== movie.url) { followBase = remote ? canonicalUrl(remote.pageUrl || '') : ''; reachedTitle = false; clearTimeout(followTimer); lastFollowUrl = ''; }
  // the host too: when a guest with control picks something, the host's tab (signed in to every
  // service) is taken there
  if (!remote || !remote.present || movie.browsing || isTheater) return; // in the window, it follows by itself
  if (!prev || prev === movie.url) return; // first load: the panel's Open button handles it
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


// ---------------------------------------------------------------- YouTube browser (host)
// Search and pick right here, no account needed. The video then plays in the embedded YouTube
// player for everyone, phones and tablets included, with no extension.
const YT_CHIPS = ['Music', 'Movie trailers', 'Bollywood songs', 'Comedy', 'Cricket highlights', 'Cooking', 'Kids'];
function openYouTube() {
  if (!isHost && !canControl()) return noPerm('playback');
  $('#ytChips').innerHTML = YT_CHIPS.map(c => `<button type="button" data-yq="${esc(c)}">${esc(c)}</button>`).join('');
  $('#ytBrowser').hidden = false;
  setTab('chat');
  const q = $('#ytQuery');
  setTimeout(() => q.focus(), 30);
  if (!$('#ytResults').childElementCount) ytSearch(YT_CHIPS[0]);
}
function closeYouTube() { $('#ytBrowser').hidden = true; }
let ytSeq = 0;
async function ytSearch(q) {
  q = String(q || '').trim();
  if (!q) return;
  // a pasted link plays straight away
  if (/^https?:\/\//i.test(q) || /youtu\.?be/i.test(q)) { conn.send({ type: 'select-url', url: q }); closeYouTube(); $('#ytQuery').value = ''; return; }
  const seq = ++ytSeq;
  $('#ytStatus').textContent = `Searching for "${q}"…`;
  // guests with control search through the host's PC too (over the room connection)
  if (!isHost) { ytPendingQ = q; conn.send({ type: 'yt-search', q }); return; }
  try {
    const r = await api(`/api/youtube/search?q=${encodeURIComponent(q)}`);
    if (seq !== ytSeq) return;
    showYtResults(q, r.results || []);
  } catch (e) {
    if (seq === ytSeq) $('#ytStatus').textContent = e.message;
  }
}
let ytPendingQ = null;
function onYtResults(m) {
  if (isHost || m.q !== ytPendingQ) return;
  if (m.error) { $('#ytStatus').textContent = m.error; return; }
  showYtResults(m.q, m.results || []);
}
function showYtResults(q, list) {
  {
    $('#ytStatus').textContent = list.length ? '' : `Nothing found for "${q}".`;
    $('#ytResults').innerHTML = list.map(v => `<button type="button" class="yt-card" data-yid="${esc(v.id)}" title="${esc(v.title)}">
      <div class="th"><img src="${esc(v.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">${v.live ? '<span class="dur live">LIVE</span>' : v.duration ? `<span class="dur">${esc(v.duration)}</span>` : ''}</div>
      <div class="t">${esc(v.title)}</div><div class="m">${esc([v.channel, v.views, v.when].filter(Boolean).join(' · '))}</div></button>`).join('');
    $('#ytResults').scrollTop = 0;
  }
}
$('#ytSearchForm').addEventListener('submit', e => { e.preventDefault(); ytSearch($('#ytQuery').value); });
$('#ytChips').addEventListener('click', e => { const b = e.target.closest('[data-yq]'); if (b) { $('#ytQuery').value = b.dataset.yq; ytSearch(b.dataset.yq); } });
$('#ytResults').addEventListener('click', e => {
  const b = e.target.closest('[data-yid]');
  if (!b) return;
  conn.send({ type: 'select-url', url: `https://www.youtube.com/watch?v=${b.dataset.yid}` });
  closeYouTube();
});
$('#ytClose').addEventListener('click', closeYouTube);
$('#ytOpen').addEventListener('click', openYouTube);
$('#ytBrowser').addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); closeYouTube(); } });


// ---------------------------------------------------------------- guests: land on the room's title
// Signing in to Netflix and the others goes through their own pages (sign in, "Who's watching?",
// profile PIN) and then usually lands on their home page instead of the show. Once a guest is past
// all that, take them to what the room is watching. Never while they're still signing in.
let keepOffSince = 0, keepLastGo = 0, reachedTitle = false;
setInterval(() => {
  if (isHost || !remote || !remote.present || !S.movie || kindOf(S.movie) !== 'service' || S.movie.browsing) { keepOffSince = 0; return; }
  const want = canonicalUrl(S.movie.url);
  const here = canonicalUrl(remote.pageUrl);
  if (here && here === want) reachedTitle = true;
  // someone with control who was on the title and then went browsing is picking the next thing: leave them be
  if (canControl() && reachedTitle) { keepOffSince = 0; return; }
  const onService = here && (S.movie.service === 'custom' ? !serviceOfUrl(here) : serviceOfUrl(here) === S.movie.service);
  const fresh = remote.page && performance.now() - remote.page.at < 6000;
  if (!want || !onService || !fresh || remote.signingIn || here === want || (remote.linked && remote.st && !remote.st.ad && canonicalUrl(remote.st.url) === want)) { keepOffSince = 0; return; }
  if (!keepOffSince) { keepOffSince = Date.now(); return; }
  // settled somewhere else on the service for a few seconds (not mid-sign-in): go
  if (Date.now() - keepOffSince < 3000 || Date.now() - keepLastGo < 15000) return;
  keepLastGo = Date.now(); keepOffSince = 0;
  toast(`Taking you to ${S.movie.title && S.movie.title !== serviceName(S.movie) ? `"${S.movie.title}"` : 'what the room is watching'}…`, { timeout: 4000 });
  if (isTheater) theaterPost({ wpTheater: 'goto', url: S.movie.url, custom: isCustom(), strict: isCustom() && !!S.movie.strict });
  else remote.navigate(S.movie.url);
}, 1000);

// top bar camera / mic (the Watch Party window with Netflix & co: the movie controls are hidden there)
$('#tbCam').addEventListener('click', () => $('#camBtn').click());
$('#tbMic').addEventListener('click', () => $('#micBtn').click());
setInterval(() => {
  const c = $('#tbCam'), m = $('#tbMic');
  const ci = S.cam ? 'cam' : 'cam-off', mi = S.mic ? 'mic' : 'mic-off';
  if (c.dataset.i !== ci) { c.dataset.i = ci; c.innerHTML = icon(ci); c.classList.toggle('on', !!S.cam); c.title = S.cam ? 'Turn your camera off' : 'Turn your camera on'; }
  if (m.dataset.i !== mi) { m.dataset.i = mi; m.innerHTML = icon(mi); m.classList.toggle('on', !!S.mic); m.title = S.mic ? 'Mute your microphone' : 'Turn your microphone on'; }
}, 400);
