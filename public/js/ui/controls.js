// The player's own controls: transport, seeking, gestures, volume, fullscreen, menus and keyboard shortcuts.
import { hideTuneIn, renderAutoSkipBtn, tuneIn } from './anime.js';
import { $, M, S, app, canControl, clientId, conn, esc, fmtTime, icon, isCustom, isHost, kindOf, localPos, player, remote, resLabel, room, stage, store, video, ytMedia } from './core.js';
import { serviceName, theaterPost, theaterSvc } from './services.js';
import { notificationCenter, openQuickChat, renderBookmarks, renderPeople, setTab, toast } from './social.js';
import { codecWarning, filePlayback, fileStartTimer, renderMoreControls, requestSubtitles, subtitleLanguage, subtitles, tryNextFileSource } from './sources.js';
import { StageFullscreen } from '../fullscreen.js';
import { PLATFORM } from '../platform.js';

// The full name as a tooltip, but only while the top bar has to cut it short.
$('#nowPlaying').addEventListener('mouseover', e => {
  const t = e.target.closest('.title');
  if (t) t.title = t.scrollWidth > t.clientWidth ? t.textContent : '';
});
function renderNowPlaying() {
  const el = $('#nowPlaying');
  const m = S.movie;
  if (!m) { el.innerHTML = `<span class="muted">${isHost ? 'Pick a movie from the library' : 'Waiting for the host'}</span>`; return; }
  const chips = [];
  if (kindOf(m) === 'catalog') {
    if (m.languageLabel) chips.push(`<span class="chip">${esc(m.languageLabel)}</span>`);
    if (m.quality) chips.push(`<span class="chip">${m.quality >= 2160 ? '4K' : `${Number(m.quality)}p`}</span>`);
    if (m.attribution?.provider) chips.push(`<span class="chip hide-sm">${esc(m.attribution.licenseLabel || m.attribution.provider)}</span>`);
    el.innerHTML = `<span class="title">${esc(m.title || 'Movies & TV')}</span>${chips.join('')}`;
    return;
  }
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

  const buffering = S.state && S.state.playing && conn.clock.now() > S.state.anchor + 600 && (M.readyState < 3 || M.seeking) && !M.error;
  const syncing = !!(player && player.syncing);
  const errored = !!(M.error && M.isAdapter);
  // Keep startup corrections hidden until YouTube has played steadily at the saved position.
  const settling = syncing && M === ytMedia && !player.blocked && !M.error;
  if (settling !== !!S._settling) { S._settling = settling; ytMedia.settling = settling; stage.classList.toggle('yt-settling', settling); }
  if (buffering !== S._buffering || syncing !== S._syncing || errored !== S._errored) {
    S._buffering = buffering; S._syncing = syncing; S._errored = errored; renderNotice();
  }
}

function renderNotice() {
  const el = $('#stageNotice');
  if (!tuneIn.awaitingMovie && S.movie && (M.error || S.filePlaybackError || player?.blocked)) hideTuneIn(true);
  let html = '';
  if (S.movie) {
    if (M.error && M.isAdapter) {
      html = `<span>${esc(M.error.message || (M.error.yt === 101 || M.error.yt === 150 ? 'The owner of this YouTube video doesn\'t allow playing it outside YouTube. The host can show it with "Everyone opens it in their own tab" instead.' : 'This video couldn\'t be loaded.'))}</span>`;
    } else if (M === remote) {
      html = ''; // the service panel explains what to do
    } else if (S.filePlaybackError) {
      html = `<span>${esc(S.filePlaybackError)} Ask the host to open Options and pick a lower picture quality if this device can't play the movie's format.</span>`;
    } else if (video.error) {
      const apple = PLATFORM.appleMobile || PLATFORM.safari;
      const message = apple
        ? S.movie.hls
          ? 'This device could not play the movie. Ask the host to open Options, pick a lower picture quality, and prepare it again.'
          : 'This movie was prepared without the "Start sooner for everyone" option. Ask the host to open Options, turn it on, and prepare the movie again.'
        : codecWarning || 'Your browser couldn\'t play this movie. Ask the host to prepare a compressed copy.';
      html = `<span>${esc(message)}</span>`;
    } else if (codecWarning && video.readyState < 1) {
      html = `<span>${esc(codecWarning)}</span>`;
    } else if (player && player.videoFailed && !pictureHintHidden(S.movie.id)) {
      html = `<span>Only hearing sound with a black picture? Turn on Chrome's "Use graphics acceleration" setting, or ask the host to open Options and pick a lower picture quality.</span><button class="btn sm" type="button" data-hide-hint>Hide</button>`;
    } else if (player && player.blocked) {
      html = `<span>Click anywhere to start watching</span>`;
    } else if (player?.syncing || S.state?.waiting || S._buffering) {
      html = '<div class="spinner" role="status" aria-label="Loading video"></div>';
    }
  }
  el.hidden = !html;
  if (el.innerHTML !== html) el.innerHTML = html;
}

for (const event of ['loadeddata', 'canplay']) video.addEventListener(event, () => clearTimeout(fileStartTimer));
video.addEventListener('error', () => {
  if (filePlayback.ownsErrors) return;
  tryNextFileSource('The direct stream was unavailable, so playback switched to Safari streaming.');
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

function noPerm(perm) {
  const text = { playback: 'Only people the host allows can play, pause or seek.', chat: 'The host turned off chat for you.', react: 'The host turned off reactions for you.', camera: 'The host hasn\'t allowed you to use your camera or mic.' }[perm] || 'Not allowed.';
  if (perm === 'playback' && isCustom()) return toast('Only the host controls this site. Your video follows the host.', { timeout: 3500 });
  const actions = perm === 'playback' ? [{ label: 'Ask the host', primary: true, run: () => { conn.send({ type: 'request-control' }); toast('Asked the host for control', { timeout: 2000 }); } }] : [];
  toast(text, { actions, timeout: 4500 });
}
function applyPerms() {
  const ctl = canControl();

  $('#libGuestNote').hidden = isHost;
  if (!isHost) $('#libGuestNote').textContent = 'You can pick what everyone watches: a movie from the host\'s PC, YouTube, anime, Netflix, Prime Video, or another supported service. Everyone in the room follows your selection.';
  for (const id of ['#playBtn', '#backBtn', '#fwdBtn']) $(id).classList.toggle('denied', !ctl);
  $('#seek').classList.toggle('locked', !ctl);
  const chatOk = isHost || S.perms.chat;
  $('#chatInput').disabled = !chatOk;
  $('#quickChatInput').disabled = !chatOk;
  $('#chatEmojiBtn').disabled = !chatOk;
  $('#chatInput').placeholder = chatOk ? 'Message everyone' : 'The host turned off chat for you';
  $('#chatForm').classList.toggle('disabled', !chatOk);
  $('#reactBtn').classList.toggle('denied', !(isHost || S.perms.react));
  $('#tbReact').classList.toggle('denied', !(isHost || S.perms.react));
  const camOk = isHost || S.perms.camera;
  $('#camBtn').classList.toggle('denied', !camOk);
  $('#micBtn').classList.toggle('denied', !camOk);
  $('#tbCam').classList.toggle('denied', !camOk);
  $('#tbMic').classList.toggle('denied', !camOk);
  renderBookmarks();
  renderPeople();
  renderAutoSkipBtn();
}

function predict(patch) {
  S.state = { ...S.state, waiting: false, waitingFor: [], ...patch };
  player.setState(S.state);
  renderNotice();
  scheduleUi();
}

let cmdRef = 0;
const seekOut = { at: -1e9, timer: null, pos: null, clickAt: 0 };
function sendCmd(action, position) {
  if (!canControl()) return noPerm('playback');
  if (!S.movie || !S.state) return;
  const at = conn.clock.now();
  if (action === 'seek') { predict({ position, anchor: at }); queueSeek(position, at); return; }
  // Send the latest skip first so pause is validated at its new destination.
  if (seekOut.timer) { clearTimeout(seekOut.timer); seekOut.timer = null; }
  if (seekOut.pos != null) flushSeek();
  conn.send({ type: 'cmd', action, position, at, ref: ++cmdRef });
  if (action === 'pause') predict({ playing: false, position, anchor: at });
  else if (action === 'play') predict({ playing: true, position, anchor: at });
}

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

  if (burst && M.isAdapter && M !== ytMedia) {
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
let pictureBrightness = 1;
function changeBrightness(delta) {
  pictureBrightness = Math.round(Math.max(.2, Math.min(1, pictureBrightness + delta)) * 100) / 100;
  stage.style.setProperty('--picture-brightness', pictureBrightness);
  osd(`Picture brightness ${Math.round(pictureBrightness * 100)}%`);
}
function changeVolume(delta) {
  if (player.autoMuted) unblock();
  let v = Math.round(Math.max(0, Math.min(1, (M.muted ? 0 : M.volume) + delta)) * 100) / 100;
  try { M.volume = v; } catch { osd('Use your device volume buttons'); return false; }
  if (Math.abs(M.volume - v) > .001) { osd('Use your device volume buttons'); return false; }
  M.muted = v === 0;
  $('#volume').value = v;
  store.set('wp.volume', v);
  osd(v === 0 ? 'Muted' : `Volume ${Math.round(v * 100)}%`);
  scheduleUi();
  return true;
}
function unblock() { player.unblock(); $('#unmutePill').hidden = true; renderNotice(); scheduleUi(); }

$('#playBtn').addEventListener('click', togglePlay);
$('#backBtn').addEventListener('click', () => seekBy(-10));
$('#fwdBtn').addEventListener('click', () => seekBy(10));
$('#unmutePill').addEventListener('click', e => { e.stopPropagation(); unblock(); });
let tapWasIdle = false, lastPointerType = 'mouse';
stage.addEventListener('pointerdown', e => { lastPointerType = e.pointerType; }, true);

const SWIPE_SKIP = 20;
let swipedAt = 0;
(() => {
  const onPicture = t => t === video || (t && t.id === 'clickLayer');

  const noSwipe = t => !t || !t.closest || !!t.closest('.controls, button, input, select, textarea, .cams, .chat-float, .quick-chat, .toasts, .notification-panel, .pop, .stage-empty');
  let sw = null;
  const begin = (x, y, target, id) => { sw = noSwipe(target) ? null : { id, x, y, at: performance.now(), wasIdle: stage.dataset.idle === 'true', claimed: false, side: x - stage.getBoundingClientRect().left < stage.clientWidth / 2 ? 'brightness' : 'volume', brightness: pictureBrightness, volume: M.muted ? 0 : M.volume }; };
  const move = (x, y) => {
    if (!sw) return;
    const dx = x - sw.x, dy = y - sw.y;
    if (!sw.axis && Math.max(Math.abs(dx), Math.abs(dy)) > 10) {
      if (Math.abs(dy) > Math.abs(dx) * 1.3) sw.axis = sw.side;
      else if (Math.abs(dx) > Math.abs(dy) * 1.3) sw.axis = 'seek';
    }
    sw.claimed = !!sw.axis;
    if (sw.axis === 'brightness') changeBrightness(sw.brightness + (sw.y - y) / Math.max(120, stage.clientHeight) - pictureBrightness);
    if (sw.axis === 'volume' && !sw.volumeBlocked) {
      const target = Math.max(0, Math.min(1, sw.volume + (sw.y - y) / Math.max(120, stage.clientHeight)));
      sw.volumeBlocked = changeVolume(target - (M.muted ? 0 : M.volume)) === false;
    }
  };
  const finish = (x, y, id) => {
    const st = sw;
    if (!st || st.id !== id) return;
    move(x, y); sw = null;
    const dx = x - st.x, dy = y - st.y;
    if (st.axis !== 'volume' && st.axis !== 'brightness') {
      if (Math.abs(dx) < Math.max(40, Math.min(100, stage.clientWidth * 0.08)) || Math.abs(dx) < Math.abs(dy) * 1.3 || performance.now() - st.at > 1200) return;
      seekBy(dx > 0 ? SWIPE_SKIP : -SWIPE_SKIP);
    }
    swipedAt = performance.now();
    if (st.wasIdle) { setIdle(true); clearTimeout(idleTimer); }
  };
  stage.addEventListener('touchstart', e => { if (e.touches.length === 1) begin(e.touches[0].clientX, e.touches[0].clientY, e.target, 'touch'); else sw = null; }, { capture: true, passive: true });
  stage.addEventListener('touchmove', e => {
    if (!sw || sw.id !== 'touch' || e.touches.length !== 1) return;
    move(e.touches[0].clientX, e.touches[0].clientY);
    if (sw.claimed && e.cancelable) e.preventDefault();
  }, { capture: true, passive: false });
  stage.addEventListener('touchend', e => { if (e.changedTouches.length) finish(e.changedTouches[0].clientX, e.changedTouches[0].clientY, 'touch'); }, { capture: true, passive: true });
  stage.addEventListener('touchcancel', () => { sw = null; }, { capture: true, passive: true });
  const hasTouchEvents = 'ontouchstart' in window;
  stage.addEventListener('pointerdown', e => { if (e.pointerType === 'mouse' || !e.isPrimary || (e.pointerType === 'touch' && hasTouchEvents)) return; begin(e.clientX, e.clientY, e.target, e.pointerId); }, true);
  stage.addEventListener('pointermove', e => { if (sw && sw.id === e.pointerId) { move(e.clientX, e.clientY); if (sw.claimed && e.cancelable) e.preventDefault(); } }, true);
  stage.addEventListener('pointercancel', () => { sw = null; }, true);
  stage.addEventListener('pointerup', e => { if (sw && sw.id === e.pointerId) finish(e.clientX, e.clientY, e.pointerId); }, true);
  // trackpad: sideways scrolling; one skip per swipe (the scroll keeps coming for a moment after the fingers lift)
  let sum = 0, lastWheel = 0, fired = false;
  stage.addEventListener('wheel', e => {
    if (!onPicture(e.target) || e.ctrlKey) return;
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX) * 1.3) { e.preventDefault(); const delta = Math.max(-.1, Math.min(.1, -e.deltaY * .002)); if (e.clientX - stage.getBoundingClientRect().left < stage.clientWidth / 2) changeBrightness(delta); else changeVolume(delta); return; }
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

const vol = $('#volume');
video.volume = store.get('wp.volume', 1);
vol.value = video.volume;
vol.addEventListener('input', () => { M.volume = +vol.value; M.muted = +vol.value === 0; store.set('wp.volume', M.volume); if (player.autoMuted) unblock(); scheduleUi(); });
$('#muteBtn').addEventListener('click', () => { if (player.autoMuted) { unblock(); return; } M.muted = !M.muted; scheduleUi(); });

(() => {
  const seek = $('#seek'), tip = $('#seekTip');

  const dur = () => S.movie?.duration || M.duration || 0;
  const frac = e => { const r = seek.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  const showTip = f => { tip.textContent = fmtTime(f * dur()); tip.style.left = (f * 100) + '%'; };
  seek.addEventListener('pointermove', e => { const f = frac(e); showTip(f); if (dragFrac != null) { dragFrac = f; scheduleUi(); } });
  seek.addEventListener('pointerdown', e => {
    if (!canControl()) return noPerm('playback');
    seek.setPointerCapture(e.pointerId);
    seek.classList.add('dragging');
    dragFrac = frac(e); showTip(dragFrac); scheduleUi();
  });
  const end = () => {
    if (dragFrac == null) return;
    const f = dragFrac; dragFrac = null;
    seek.classList.remove('dragging');
    sendCmd('seek', f * dur());
  };
  seek.addEventListener('pointerup', end);
  seek.addEventListener('pointercancel', () => { dragFrac = null; seek.classList.remove('dragging'); });
})();

const fullscreen = new StageFullscreen(stage, fs => {
  $('#fsBtn').innerHTML = icon(fs ? 'fs-exit' : 'fs');
  const label = fullscreen.pageMode ? 'Exit expanded player' : fs ? 'Exit fullscreen' : 'Fullscreen';
  $('#fsBtn').setAttribute('aria-label', label);
  $('#fsBtn').title = label;
  poke();
}, { onUnavailable: () => {
  // Some iPad browsers turn a stage request into video-only fullscreen.
  // Leave that presentation before expanding the stage with our HTML controls.
  try { if (video.webkitDisplayingFullscreen) video.webkitExitFullscreen?.(); } catch {}
  fullscreen.expandPage();
} });
function isFs() { return fullscreen.active; }
function toggleFullscreen() { fullscreen.toggle().catch(() => {}); }
$('#fsBtn').addEventListener('click', toggleFullscreen);

let idleTimer = null, goneTimer = null;
const controlsEl = $('#controls');
function setIdle(idle) {
  clearTimeout(goneTimer);
  for (const el of [controlsEl, ...stage.querySelectorAll('.anime-actions')]) el.inert = idle;
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
    const hovered = matchMedia('(hover: hover)').matches
      && stage.querySelector('.controls:hover, .anime-actions:hover');
    const keyboard = stage.querySelector('.controls :focus-visible, .anime-actions :focus-visible');
    const busy = !$('#reactPop').hidden || !$('#ccPop').hidden || !$('#notificationPanel').hidden
      || !$('#playerMorePop').hidden || !$('#quickChat').hidden || hovered || keyboard || dragFrac != null;
    if (S.state && S.state.playing && !busy) setIdle(true); else poke();
  }, 2800);
}

let lastMove = 0;
const wake = e => {
  if (e && e.type.endsWith('move')) { const now = performance.now(); if (now - lastMove < 60) return; lastMove = now; }

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

function closePops(except) {
  for (const p of ['#reactPop', '#tbReactPop', '#ccPop', '#chatEmojiPop', '#playerMorePop', '#notificationPanel']) if (p !== except) $(p).hidden = true;
  if (except !== '#playerMorePop') $('#playerMoreBtn').setAttribute('aria-expanded', 'false');
  if (except !== '#notificationPanel') $('#notificationBtn').setAttribute('aria-expanded', 'false');
  if (except !== '#chatEmojiPop') $('#chatEmojiBtn').setAttribute('aria-expanded', 'false');
}
function togglePop(id) {
  const el = $(id), open = el.hidden;
  if (id === '#playerMorePop') {
    renderMoreControls();
    el.style.maxHeight = Math.max(64, Math.min(480, stage.clientHeight - 96, window.innerHeight * .65)) + 'px';
  }
  closePops(id); el.hidden = !open; if (id === '#notificationPanel') notificationCenter.render(); poke();
}
$('#playerMoreBtn').addEventListener('click', e => {
  e.stopPropagation(); togglePop('#playerMorePop');
  $('#playerMoreBtn').setAttribute('aria-expanded', String(!$('#playerMorePop').hidden));
});
let forwardingMoreControl = false;
$('#playerMorePop').addEventListener('click', e => {
  const action = e.target.closest('[data-control]');
  if (!action || action.disabled) return;
  e.stopPropagation();
  if (!action.dataset.toggle) closePops();
  forwardingMoreControl = true;
  try { document.getElementById(action.dataset.control)?.click(); }
  finally { forwardingMoreControl = false; }
  renderMoreControls();
  poke();
});

document.addEventListener('click', e => {
  if (!forwardingMoreControl && !e.target.closest('.pop-wrap')) closePops();
});

function subtitleTimingKey(movie = S.movie) {
  const id = kindOf(movie) === 'anime' ? `anime-${movie.anilistId}-${movie.language}` : movie?.id || 'none';
  return `wp.subtitleTiming.${id}`;
}

function buildCcMenu() {
  const pop = $('#ccPop');
  if (S.movie?.kind === 'youtube') {
    const enabled = !!ytMedia?.captionsEnabled;
    const available = ytMedia?.captionsAvailable;
    pop.innerHTML = '<div class="menu-label">YouTube captions</div>' +
      `<button type="button" data-yt-cc="off" class="${!enabled ? 'sel' : ''}">Off</button>` +
      `<button type="button" data-yt-cc="on" class="${enabled ? 'sel' : ''}" ${available === false ? 'disabled' : ''}>On · Automatic</button>` +
      ((ytMedia?.captionSources || []).some(t => t.kind === 'asr') ? '<button type="button" data-yt-cc="generated">Start auto-generated captions</button>' : '') +
      ((ytMedia?.captionTracks || []).length ? `<label class="caption-language">Subtitle language<select data-yt-language aria-label="Subtitle language">${ytMedia.captionTracks.map((track, i) => `<option value="${esc(track.language)}" ${ytMedia.captionLanguage === track.language || !ytMedia.captionLanguage && i === 0 ? 'selected' : ''}>${esc(track.label)}</option>`).join('')}</select></label><button type="button" data-yt-cc="language">Use selected language</button>` : '') +
      (ytMedia?.captionError ? `<div class="menu-note">${esc(ytMedia.captionError)}</div>` :
        available === false ? '<div class="menu-note">This video has no captions.</div>' :
          available === null ? '<div class="menu-note">Loading subtitle languages…</div>' : '');
    $('#ccBtn').classList.toggle('on', enabled && available !== false);
    $('#ccBtn').setAttribute('aria-pressed', String(enabled && available !== false));
    return;
  }
  const subs = S.movie?.subs || [];
  const active = subtitles.selected;
  let html = '<div class="menu-label">Subtitles</div>';
  html += `<button type="button" data-sub="" title="Hide all captions." class="${!active ? 'sel' : ''}">Off</button>`;
  for (const s of subs) html += `<button type="button" data-sub="${esc(s.key)}" class="${active === s.key ? 'sel' : ''}">${esc(s.label)}${s.automatic ? ' (alternative)' : s.local ? ' (saved)' : ''}${subtitles.status(s.key) === 'error' ? ' — unavailable' : ''}</button>`;
  if (!subs.length) html += '<div class="menu-note">No Local Subtitles</div>';
  if (S.movie?.kind === 'anime') {
    const lang = subtitleLanguage(subtitles.sources.get(active));
    const search = S.movie.subtitleSearch?.[lang];
    html += `<button type="button" data-find-sub="${esc(lang)}" ${search?.state === 'searching' ? 'disabled' : ''}>${search?.state === 'searching' ? 'Finding subtitles…' : 'Find alternative subtitles'}</button>`;
    if (search?.message) html += `<div class="menu-note">${esc(search.message)}</div>`;
  }
  if (active && subtitles.status(active) === 'loading') html += '<div class="menu-note">Loading subtitles…</div>';
  if (active && subtitles.status(active) === 'error') html += '<div class="menu-note">The subtitle file could not be downloaded. Select the language again to retry.</div>';
  if (active) html += `<div class="menu-label">Timing: ${subtitles.offset >= 0 ? '+' : ''}${subtitles.offset.toFixed(1)} s</div><div class="caption-timing"><button type="button" data-sub-shift="-0.5">Earlier</button><button type="button" data-sub-shift="reset">Reset</button><button type="button" data-sub-shift="0.5">Later</button></div>`;
  pop.innerHTML = html;
  $('#ccBtn').classList.toggle('on', !!active);
  $('#ccBtn').setAttribute('aria-pressed', String(!!active));
}
window.wpSelectSub = (k, remember = true) => selectSub(k, remember);
function selectSub(k, remember = true) {
  subtitles.select(k);
  if (remember) {
    const s = (S.movie?.subs || []).find(x => x.key === k);
    store.set('wp.subLang', s ? s.lang : null);
    store.set('wp.subLabel', s ? s.label : null);
  }
  buildCcMenu();
}
$('#ccBtn').addEventListener('click', e => { e.stopPropagation(); if (S.movie?.kind === 'youtube') ytMedia?.refreshCaptionMetadata(); buildCcMenu(); togglePop('#ccPop'); });
$('#ccPop').addEventListener('click', e => {
  const youtube = e.target.closest('[data-yt-cc], [data-yt-lang]');
  if (youtube && S.movie?.kind === 'youtube' && !youtube.disabled) {
    const enabled = youtube.dataset.ytCc !== 'off', language = youtube.dataset.ytCc === 'language' ? $('#ccPop').querySelector('[data-yt-language]').value : youtube.dataset.ytCc === 'generated' ? ytMedia.captionSources.find(t => t.kind === 'asr').languageCode : youtube.dataset.ytLang || '';
    ytMedia.setCaptions(enabled, language);
    if (youtube.dataset.ytCc === 'generated') toast('YouTube auto-generated captions enabled.', { timeout: 3000 });
    store.set('wp.youtubeCaptions', { enabled, language });
    closePops(); return;
  }
  const find = e.target.closest('[data-find-sub]');
  if (find) { requestSubtitles(find.dataset.findSub, true); return; }
  const timing = e.target.closest('[data-sub-shift]');
  if (timing) {
    const value = timing.dataset.subShift;
    subtitles.setOffset(value === 'reset' ? 0 : subtitles.offset + Number(value));
    store.set(subtitleTimingKey(), subtitles.offset);
    return;
  }
  const b = e.target.closest('[data-sub]');
  if (!b) return;
  selectSub(b.dataset.sub || null);
  closePops();
});
$('#ccPop').addEventListener('change', e => {
  if (!e.target.matches('[data-yt-language]') || S.movie?.kind !== 'youtube') return;
  const language = e.target.value;
  ytMedia.setCaptions(true, language);
  store.set('wp.youtubeCaptions', { enabled: true, language });
  closePops();
});

document.addEventListener('keydown', e => {
  if (app.dataset.screen !== 'room') return;
  // sliders (volume, seek bar) and buttons keep focus after a click; the arrow keys should still work then
  const field = (e.composedPath?.()[0] || e.target).closest('input:not([type=range]):not([type=checkbox]):not([type=radio]):not([type=button]), textarea, select, [contenteditable]');
  if (e.key === 'Escape') { closePops(); $('#quickChat').hidden = true; return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if ((e.key === 'Enter' || e.key === ' ') && (e.composedPath?.()[0] || e.target).closest('button')) return;
  // in an empty chat box, up/down still change the volume
  if (field && !((e.key === 'ArrowUp' || e.key === 'ArrowDown') && field.tagName === 'INPUT' && ['chatInput', 'quickChatInput'].includes(field.id) && !field.value)) return;
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

export { applyPerms, buildCcMenu, closePops, isFs, noPerm, poke, renderNotice, renderNowPlaying, scheduleUi, seekBy, selectSub, sendCmd, staleOwnEcho, subtitleTimingKey, togglePlay, togglePop };
