// Entry: connects to the room, routes its messages and loads whatever the room is watching. Features live in ./ui/.
import './emoji-picker.js';
import { hideTuneIn, onAnimeResults, renderAnimeHistory, renderAnimeOverlay, renderAutoSkipBtn, saveAnimeProgress, savePlaybackProgress, showTuneInForMovie, tuneIn, updateAnimeSkip } from './ui/anime.js';
import { closeYouTube, finishCatalogServiceLaunch, onCatalogResponse, onYouTubeEnded, onYtResults, openYouTube } from './ui/browse.js';
import { applyPerms, buildCcMenu, noPerm, renderNotice, renderNowPlaying, scheduleUi, staleOwnEcho, subtitleTimingKey } from './ui/controls.js';
import { $, M, PLAYBACK, S, app, canControl, clientId, conn, isHost, isNativeMovie, isTheater, key, kindOf, mediaFor, mesh, mode, player, rememberClientId, remote, set, stage, store, video, ytMedia } from './ui/core.js';
import { animateHandoff, loadLibrary, loadLibrarySoon, openInvite, refreshInfo, refreshInfoSoon, renderLibrary, renderLibraryCurrent, renderSettings, updateJob } from './ui/host.js';
import { bringAlong, checkExtensionUpdate, dockPushSoon, enterTheater, extProblem, maybeSendMeta, onDockMessage, onRemoteUserAction, openNetflixInParty, refreshExtensionPackage, renderServicePanel, renderServiceTiles, theaterReportSoon } from './ui/services.js';
import { addChat, buildReactions, notificationCenter, renderBookmarks, renderCams, renderObservatory, renderPeople, renderPeopleDrift, scheduleReaction, setTab, stopLocal, toast } from './ui/social.js';
import { addSubtitleTracks, checkCodecSupport, filePlayback, maybeFindSubtitles, movieSources, openFileSource, refreshFileSources, subtitles, syncAmbient, watchFileStart } from './ui/sources.js';
import { initLiveCaptions } from './live-captions.js';
import { RemoteMedia, YouTubeMedia } from './media.js';
import { Connection } from './net.js';
import { PLATFORM } from './platform.js';
import { SyncPlayer } from './player.js';
import { Mesh } from './rtc.js';

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

$('#themeBtn').addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  store.set('wp.theme', theme);
  wpTheme(theme);
  if (S.pipWin) S.pipWin.document.documentElement.dataset.theme = theme;
});

function screen(name) { app.dataset.screen = name; }

function showDenied(title, text) {
  $('#deniedTitle').textContent = title;
  $('#deniedText').textContent = text;
  screen('denied');
}

function start(name) {
  S.name = name;
  screen('loading');
  set.conn(new Connection(key, () => ({ type: 'hello', clientId, name: S.name, capabilities: PLAYBACK })));
  set.mesh(new Mesh({
    send: m => conn.send(m),
    onRemoteStream: (id, stream) => { S.remoteStreams.set(id, stream); renderCams(); },
    onPeerGone: id => { S.remoteStreams.delete(id); renderCams(); },
  }));
  set.ytMedia(new YouTubeMedia($('#ytHost'), {
    loadCaptionMetadata: async videoId => {
      const response = await fetch(`/youtube/captions/${encodeURIComponent(videoId)}?k=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(10000) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load YouTube subtitle languages.');
      return data;
    },
    captionPreference: () => store.get('wp.youtubeCaptions', { enabled: false, language: '' }),
    onCaptionsChange: () => { if (S.movie?.kind === 'youtube') buildCcMenu(); },
  }));
  set.remote(new RemoteMedia({ onInfo: () => {
    renderServicePanel(); maybeSendMeta();
    finishCatalogServiceLaunch();
    checkExtensionUpdate();
    openNetflixInParty();
  } }));
  remote.onProblem = extProblem;
  remote.onLaunchResult = result => { if (result.error) toast(result.error, { kind: 'error', timeout: 12000 }); };
  remote.onUser = onRemoteUserAction;
  // the level set in Netflix & co's own player shows on the party's slider too (and is remembered)
  remote.onUserVolume = (v, muted) => { if (M !== remote) return; $('#volume').value = muted ? 0 : v; store.set('wp.volume', v); scheduleUi(); dockPushSoon(); };
  remote.onDock = onDockMessage;
  set.player(new SyncPlayer({
    video, clock: conn.clock,
    onStatus: st => { conn.send({ type: 'status', status: st }); saveAnimeProgress(st, M.paused || st.ended); savePlaybackProgress(st, M.paused || st.ended); },
    onBlocked: kind => { $('#unmutePill').hidden = false; if (kind === 'blocked') renderNotice(); },
    onChange: () => { scheduleUi(); if (!tuneIn.awaitingMovie) { if (M?.error) hideTuneIn(true); else if (M && M.readyState >= (M.isAdapter ? 1 : 3)) hideTuneIn(); } },
  }));
  ytMedia.addEventListener('ended', onYouTubeEnded);
  wire();
  initLiveCaptions({ conn, video, key, isHost, notify: message => notificationCenter.record(message, 'error', []) });
  conn.connect();
  refreshExtensionPackage();
  clearInterval(S.extPackagePoll);
  S.extPackagePoll = setInterval(refreshExtensionPackage, 60000);
}

function wire() {
  conn.on('status', s => {
    const pill = $('#connPill');
    pill.classList.toggle('ok', s === 'open');
    pill.classList.toggle('bad', s === 'reconnecting');
    pill.querySelector('b').textContent = s === 'open' ? 'Connected' : s === 'reconnecting' ? 'Reconnecting…' : 'Connecting…';
  });
  conn.on('clock', c => { if (c.rtt != null) $('#connPill').title = `Connected · ${Math.round(c.rtt)} ms round trip`; });
  conn.on('pending', m => { rememberClientId(m.you); screen('pending'); });
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
    if (['play', 'seek'].includes(m.action) && m.state.position < (M?.duration || Infinity) - 1) $('#ytEndScreen').hidden = true;
    if (m.action === 'ended' && S.movie?.kind === 'youtube') onYouTubeEnded();
    S.serverState = m.state;
    if (staleOwnEcho(m)) return; // a newer skip / play / pause of ours is already on its way
    S.state = m.state;
    player.setState(m.state);
    renderNotice();
    scheduleUi();
  });
  conn.on('movie', m => loadMovie(m.movie));
  conn.on('people', m => { S.people = m.people; S.totalMbps = m.totalMbps || 0; renderPeople(); renderNowPlaying(); renderCams(); renderNotice(); renderLibraryCurrent(); });
  conn.on('observatory', m => { S.observatory = m.observatory || null; renderObservatory(); renderPeopleDrift(); });
  conn.on('chat', m => addChat(m.message, true));
  conn.on('react', scheduleReaction);
  conn.on('notification', m => notificationCenter.add(m.notification));
  conn.on('notifications-clear', () => notificationCenter.clear());
  conn.on('bookmarks', m => { S.bookmarks = m.bookmarks || []; renderBookmarks(); });
  conn.on('perms', m => {
    S.perms = m.perms;
    applyPerms();
    const names = { playback: 'playback control', chat: 'chat', react: 'reactions', camera: 'camera and mic' };
    toast(`The host ${m.value ? 'gave you' : 'turned off'} ${names[m.changed] || m.changed}`, { timeout: 3500 });
  });
  conn.on('settings', m => { S.settings = m.settings; renderSettings(); renderPeople(); renderServicePanel(); maybeFindSubtitles(); renderAutoSkipBtn(); updateAnimeSkip(); });
  conn.on('toast', m => {
    if (m.selection === 'anime' && m.kind === 'error') hideTuneIn(true);
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
  conn.on('anime-results', m => onAnimeResults(m));
  conn.on('anime-history', m => { S.animeHistory = m.episodes || []; S.animeContinueHidden = m.hidden || []; renderAnimeHistory(); });
  conn.on('playback-history', m => { S.playbackHistory = m.entries || []; renderAnimeHistory(); });
  conn.on('catalog-response', m => onCatalogResponse(m));
  conn.on('job', m => updateJob(m.id, m.job));
  conn.on('network', () => refreshInfoSoon());
  conn.on('link-changed', () => { refreshInfo().then(() => openInvite()); toast('New invite link created. Share it with your guests again.'); });
}

function onWelcome(m) {
  // A tab left open across an update reconnects by itself but keeps running the old page code: reload it.
  if (S.build && m.build && m.build !== S.build) { location.reload(); return; }
  S.build ||= m.build;
  rememberClientId(m.you);
  S.me = m.you;
  notificationCenter.load(m.notifications || [], m.notificationSession);
  S.perms = m.you.perms;
  S.settings = m.settings || {};
  S.reactions = m.reactions || [];
  S.bookmarks = m.bookmarks || [];
  S.animeHistory = m.animeHistory || [];
  S.animeContinueHidden = m.animeContinueHidden || [];
  S.playbackHistory = m.playbackHistory || [];
  if (isHost) remote?.post({ type: 'playback-history' });
  renderAnimeHistory();
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
  loadLibrary();
  if (isHost) {
    refreshInfo();
    if (!m.movie && S.tab === 'chat' && !S._openedLib) { S._openedLib = true; setTab('library'); }
  }
}

function teardownMedia() {
  try { mesh && mesh.closeAll(); } catch {}
  for (const k of ['audio', 'video']) if (mesh && mesh.local[k]) { mesh.local[k].stop(); mesh.local[k] = null; }
  filePlayback.close();
  try { video.pause(); } catch {}
}

function loadMovie(movie) {
  const same = S.movie && movie && S.movie.id === movie.id && kindOf(S.movie) === kindOf(movie);
  if (S.movie?.service === 'netflix' && movie?.service !== 'netflix') {
    S.netflixExternal = S.netflixTheaterFailed = false;
    clearTimeout(enterTheater.timer); enterTheater.timer = null;
  }
  if (!same) S.observatory = null;
  S.movie = movie;
  if (!same) { $('#ytEndScreen').hidden = true; S.youtubeRecommendations = []; }
  if (!movie || kindOf(movie) === 'service') hideTuneIn(true);
  syncAmbient();
  stage.classList.toggle('has-movie', !!movie);
  app.classList.toggle('at-home', !movie);
  stage.dataset.kind = kindOf(movie);
  if (!same && movie?.kind === 'youtube') {
    if (matchMedia('(min-width: 1100px)').matches) openYouTube();
    else closeYouTube();
  }
  if (movie?.kind !== 'youtube') stage.classList.remove('youtube-browse-watch');
  renderAnimeOverlay();
  renderAutoSkipBtn();
  $('#ytOpen').hidden = kindOf(movie) !== 'youtube';
  renderNowPlaying();
  theaterReportSoon();
  renderServiceTiles();
  bringAlong(movie);
  renderLibraryCurrent();
  renderServicePanel();
  renderObservatory();
  renderBookmarks();
  if (!isHost && S.perms) applyPerms(); // a custom site takes control away from guests while it's on
  if (same) {
    if (kindOf(movie) === 'service' && movie.launchId && movie.launchId !== remote.movie?.launchId) remote.open(movie);
    if (isNativeMovie(movie)) {
      player.movie = movie;
      refreshFileSources(movie);
      addSubtitleTracks(movie);
      if (kindOf(movie) === 'file') checkCodecSupport(movie);
      renderNotice();
    }
    finishCatalogServiceLaunch();
    openNetflixInParty();
    return;
  }
  subtitles.reset(movie?.id);
  subtitles.setOffset(store.get(subtitleTimingKey(movie), 0));
  const media = mediaFor(movie);
  if (media !== M) {
    // carry the viewer's volume over to the new player
    const vol = store.get('wp.volume', 1);
    set.M(media);
    try { M.volume = vol; } catch {}
  }
  S.metaSent = null;
  S.fileSources = isNativeMovie(movie) ? movieSources(movie) : [];
  S.fileSourceIndex = 0;
  S.filePlaybackError = null;
  filePlayback.close();
  player.setMovie(movie, null, media);
  if (isNativeMovie(movie) && S.fileSources[0]) openFileSource(S.fileSources[0]);
  watchFileStart();
  if (movie && isNativeMovie(movie)) {
    addSubtitleTracks(movie);
    if (kindOf(movie) === 'file') checkCodecSupport(movie);
  } else {
    $('#emptyTitle').textContent = 'Nothing is playing yet';
    $('#emptyText').textContent = isHost ? 'Pick a movie from your library, then invite people.' : canControl() ? 'Pick a movie or a streaming service in the Library tab, or wait for the host.' : 'The host will pick a movie.';
  }
  if (movie && !isNativeMovie(movie)) checkCodecSupport(movie); // an embed has no codec to probe, so this clears the warning
  buildCcMenu();
  renderNotice();
  finishCatalogServiceLaunch();
  openNetflixInParty();
  if (kindOf(movie) === 'anime') showTuneInForMovie(movie);
}

// handy for troubleshooting from the browser console
window.__wp = { S, get player() { return player; }, get conn() { return conn; }, get mesh() { return mesh; }, get remote() { return remote; }, pipDoc: () => S.pipWin?.document, clientId };

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
