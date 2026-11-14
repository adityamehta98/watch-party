// Everything between people: reactions, notifications, chat, saved scenes, cameras, the people list and the pop-out window.
import { closePops, isFs, noPerm, poke, seekBy, sendCmd, togglePlay, togglePop } from './controls.js';
import { $, $$, M, S, avatar, canControl, clientId, conn, esc, fmtTime, hue, icon, isHost, isTheater, kindOf, localPos, mesh, randId, remote, room, setHtml, stage, store } from './core.js';
import { loadLibrary, openInvite } from './host.js';
import { dockPushSoon, openNetflixSeparate, theaterPost, theaterSvc } from './services.js';
import { renderMoreControls, visuals } from './sources.js';
import { createCameraGallery } from '../camera-gallery.js';
import { createNotificationCenter } from '../notifications.js';

let emojiCatalogPromise;
const loadEmojiCatalog = () => emojiCatalogPromise ||= fetch('/data/emoji.json').then(response => { if (!response.ok) throw Error('Emoji catalog unavailable'); return response.json(); }).catch(error => { emojiCatalogPromise = null; throw error; });
const sendReaction = emoji => { if (isHost || S.perms.react) conn.send({ type: 'react', emoji }); else noPerm('react'); };
function buildReactions() {
  const html = S.reactions.map(r => `<button type="button" data-emoji="${esc(r)}">${esc(r)}</button>`).join('');
  $('#reactPop').innerHTML = html;
  $('#tbReactPop').innerHTML = html;
}
const chatDraft = WpEmoji.createDraft($('#chatInput'));
const chatPicker = WpEmoji.create($('#chatEmojiPop'), { load: loadEmojiCatalog, giphyKey: () => S.settings.giphyKey || '', onPick: emoji => {
  if (!(isHost || S.perms.chat)) return noPerm('chat');
  chatDraft.pick(emoji); closePops();
} });
$('#reactBtn').addEventListener('click', e => { e.stopPropagation(); if (!(isHost || S.perms.react)) return noPerm('react'); togglePop('#reactPop'); });
$('#tbReact').addEventListener('click', e => { e.stopPropagation(); if (!(isHost || S.perms.react)) return noPerm('react'); togglePop('#tbReactPop'); });
function onReactClick(e) { const b = e.target.closest('[data-emoji]'); if (b && S.reactions.includes(b.dataset.emoji)) sendReaction(b.dataset.emoji); }
$('#reactPop').addEventListener('click', onReactClick);
$('#tbReactPop').addEventListener('click', onReactClick);
$('#chatEmojiBtn').addEventListener('click', e => {
  e.stopPropagation(); if (!(isHost || S.perms.chat)) return noPerm('chat'); togglePop('#chatEmojiPop');
  $('#chatEmojiBtn').setAttribute('aria-expanded', String(!$('#chatEmojiPop').hidden)); if (!$('#chatEmojiPop').hidden) chatPicker.open();
});
function scheduleReaction(m) {
  const delay = Number(m.at) - conn.clock.now();
  // An unsynced phone clock must not discard live reactions. Judge age on
  // arrival; a delayed foreground timer should not erase an accepted reaction.
  if (conn.clock.synced && Number.isFinite(delay) && delay < -10000) return;
  const fire = () => {
    if (m.movieId && m.movieId !== S.movie?.id) return;
    floatReaction(m.emoji, m.name);
  };
  if (conn.clock.synced && delay > 10 && delay <= 2000) setTimeout(fire, delay); else fire();
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

let theaterToastSeq = 0;
const theaterToastActions = new Map();
const notificationCenter = createNotificationCenter($('#notificationPanel'), { send: message => conn?.send(message), host: isHost, id: randId });
$('#notificationBtn').addEventListener('click', e => { e.stopPropagation(); togglePop('#notificationPanel'); $('#notificationBtn').setAttribute('aria-expanded', String(!$('#notificationPanel').hidden)); });
$('#notificationClose').addEventListener('click', () => { $('#notificationPanel').hidden = true; $('#notificationBtn').setAttribute('aria-expanded', 'false'); });
function toast(text, { kind = 'info', actions = [], timeout = 4000 } = {}) {
  const box = $('#toasts');
  notificationCenter.record(text, kind, actions);
  for (const old of [...box.children]) { clearTimeout(old.timer); theaterToastActions.delete(old.dataset.theaterId); theaterPost({ wpTheater: 'toast-dismiss', id: old.dataset.theaterId }); old.remove(); }
  const el = document.createElement('div');
  const theaterId = `notice-${++theaterToastSeq}`;
  el.dataset.theaterId = theaterId;
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="t">${esc(text)}</span>${actions.length ? `<span class="acts">${actions.map((a, i) => `<button type="button" class="btn sm ${a.primary ? 'primary' : ''}" data-i="${i}">${esc(a.label)}</button>`).join('')}</span>` : ''}`;
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-i]');
    if (b) { actions[+b.dataset.i].run(); theaterToastActions.delete(theaterId); theaterPost({ wpTheater: 'toast-dismiss', id: theaterId }); el.remove(); }
  });
  box.appendChild(el);

  if (isTheater) {
    if (actions.length) theaterToastActions.set(theaterId, actions);
    theaterPost({ wpTheater: 'toast', id: theaterId, text: String(text || '').slice(0, 500), kind, timeout, actions: actions.map(a => ({ label: String(a.label || '').slice(0, 60), primary: !!a.primary })) });
  }
  el.timer = setTimeout(() => { el.remove(); theaterToastActions.delete(theaterId); }, timeout);
  return el;
}
window.addEventListener('message', e => {
  if (!isTheater || e.source !== window.parent || !e.data || e.origin !== location.ancestorOrigins?.[0] || !/^chrome-extension:\/\/[a-p]{32}$/.test(e.origin)) return;
  if (e.data.wpTheater === 'pip-state') {
    S.theaterPip = !!e.data.open;
    $('#pipBtn').classList.toggle('live', S.theaterPip);
    if (e.data.error) toast(String(e.data.error), { kind: 'error', timeout: 4500 });
    return;
  }
  if (e.data.wpTheater === 'open-netflix-separate') { openNetflixSeparate(); return; }
  if (e.data.wpTheater !== 'toast-action') return;
  const actions = theaterToastActions.get(String(e.data.id || ''));
  const action = actions && actions[Number(e.data.index)];
  if (!action) return;
  theaterToastActions.delete(String(e.data.id || ''));
  action.run();
});

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
    el.innerHTML = `${avatar(m.name)}<div><div class="who" style="color:hsl(${hue(m.name)} 70% var(--name-l))">${esc(m.name)}${m.host ? ' <span class="host-tag">HOST</span>' : ''}<time>${t}</time></div><div class="body">${WpEmoji.chatHtml(m.text)}${moment}</div></div>`;
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
  el.innerHTML = `<b>${esc(m.name)}</b>${WpEmoji.chatHtml(m.text)}`;
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
  input.value = ''; input.dispatchEvent(new Event('input'));
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

function setTab(t) {
  S.tab = t;
  for (const b of $$('.tab')) {
    const active = b.dataset.tab === t;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', String(active));
  }
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
  for (const [name, on, ids] of [['cam', S.cam, ['#camBtn', '#tbCam']], ['mic', S.mic, ['#micBtn', '#tbMic']]]) {
    for (const id of ids) { $(id).innerHTML = icon(on ? name : `${name}-off`); $(id).classList.toggle('live', on); }
  }
  renderMoreControls();
  renderCams();
}
$('#camBtn').addEventListener('click', () => (S.cam ? stopLocal('video') : startLocal('video')));
$('#micBtn').addEventListener('click', () => (S.mic ? stopLocal('audio') : startLocal('audio')));

const tiles = new Map();
const cameraGallery = createCameraGallery($('#cams'));

function placeTiles() {
  cameraGallery.sync(tiles);
  cameraGallery.layout(stage.clientWidth, stage.clientHeight);
}

function renderCams() {
  if (!mesh) return;
  const box = $('#cams');
  // Only people sharing video get a tile; camera-off participants (mic-only or nothing) show no tile.
  const want = [];
  if (S.cam) want.push({ id: clientId, name: S.me?.name || S.name, self: true, media: { cam: S.cam, mic: S.mic } });
  for (const [id, p] of S.peers) if (p.media && p.media.cam) want.push({ id, name: p.name, self: false, media: p.media });
  const keep = new Set(want.map(w => w.id));
  for (const [id, t] of tiles) if (!keep.has(id)) { t.el.remove(); tiles.delete(id); }
  for (const w of want) {
    let t = tiles.get(w.id);
    if (!t) {
      const el = document.createElement('div');
      el.className = 'tile' + (w.self ? ' self' : '');
      el.innerHTML = `<video autoplay playsinline ${w.self ? 'muted' : ''}></video><div class="avatar">${avatar(w.name, '')}</div><div class="label"></div>`;
      box.appendChild(el);
      t = { el, v: el.querySelector('video') };
      tiles.set(w.id, t);
    }
    t.name = w.self ? 'your' : w.name;
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
  placeTiles();
}
if (window.ResizeObserver) new ResizeObserver(() => placeTiles()).observe(stage);

function renderPeople() {
  renderBadges();
  const el = $('#peopleList');
  const pending = S.people.filter(p => !p.admitted);
  const here = S.people.filter(p => p.admitted);
  let html = '';
  if (isHost && pending.length) {
    html += `<div class="pending-box"><div class="section-label">Waiting to join</div>` + pending.map(p => `
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
      if (st.dev && !me) sub.push(esc(st.dev));
      // "stalled 3×": this person's movie ran out of data 3 times (only counted for your own movie files)
      if (S.movie && st.stalls > 0 && !me) sub.push(`<span class="${st.stalls >= 3 ? 'bad' : ''}" title="Times their video ran out of data and had to wait">stalled ${st.stalls}×</span>`);
    } else if (st.buffering) sub.push('<span class="bad">Buffering</span>');
    // the host gets a plain-language reason when someone keeps stalling
    let why = '';
    if (isHost && p.role !== 'host' && S.movie && kindOf(S.movie) === 'file' && (st.stalls >= 3 || st.noWait)) {
      const need = S.movie.mbps || 0;
      const phone = /iPhone|iPad|phone|tablet/i.test(st.dev || '');
      if (need && p.mbps > 0.3 && p.mbps < need * 0.85) why = `Their internet can't keep up with this movie. Open the movie in your Library, hit Options, and pick a lower picture quality.`;
      else if (phone) why = `Their ${esc(st.dev)} keeps running out of video. Phones and tablets struggle with large files. Open the movie in your Library, hit Options, and pick a lower picture quality.`;
      else why = `They keep running out of video even though the speed looks fine. Ask them to close other tabs and downloads, or prepare the movie at a lower picture quality from your Library (Options).`;
      if (st.noWait) why += ' The room no longer pauses for them; they catch up on their own.';
    }
    const drift = isHost && p.role !== 'host' ? `${sub.length ? '<span data-drift-sep hidden>·</span>' : ''}<span data-drift="${esc(p.id)}" hidden></span>` : '';
    html += `<div class="person" data-id="${p.id}"><div class="person-top">${avatar(p.name)}
      <div style="min-width:0"><div class="nm"><span>${esc(p.name)}${me ? ' (you)' : ''}</span>${p.role === 'host' ? '<span class="host-tag">HOST</span>' : ''}</div>
      ${sub.length || drift ? `<div class="sub">${sub.join('<span>·</span>')}${drift}</div>` : ''}
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
  setHtml(el, html);
  renderPeopleDrift();
}

function renderPeopleDrift() {
  if (!isHost) return;
  const metrics = new Map((S.observatory?.participants || []).map(p => [p.id, p.status || {}]));
  for (const slot of $$('[data-drift]')) {
    const st = metrics.get(slot.dataset.drift);
    const drift = Math.round(Number(st?.drift) || 0);
    const visible = !!S.movie && !!st?.loaded && !st?.buffering && Math.abs(drift) > 60;
    slot.hidden = !visible;
    slot.textContent = visible ? `${drift > 0 ? '+' : ''}${drift} ms` : '';
    const separator = slot.previousElementSibling;
    if (separator?.matches('[data-drift-sep]')) separator.hidden = !visible;
  }
}

function renderObservatory() {
  const el = $('#observatory');
  const obs = S.observatory || { confidence: null, timeline: [], recommendations: [] };
  if (!S.movie || obs.confidence == null) {
    return setHtml(el, `<div class="obs-empty"><b>Sync Observatory</b><p class="fine">Start a movie or streaming service to see live room timing.</p></div>`);
  }
  const tone = value => value >= 85 ? 'good' : value >= 65 ? 'warn' : 'bad';
  const score = Math.max(0, Math.min(100, Number(obs.confidence) || 0));
  const people = obs.participants || [];
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
  setHtml(el, `<div class="obs-head"><div class="confidence-ring ${tone(score)}" style="--score:${score * 3.6}deg"><b>${score}</b><small>sync confidence</small></div><div><h3>Sync Observatory</h3><p>Live timing across ${people.length} participant${people.length === 1 ? '' : 's'}</p></div></div>
    ${recommendations ? `<div class="obs-recommendations">${recommendations}</div>` : ''}
    <div class="section-label">Participants</div>${participants || '<p class="fine">Waiting for player telemetry…</p>'}
    <div class="section-label">Room timeline</div><div class="obs-timeline"><span></span>${markers}</div>${recent ? `<ul class="obs-events">${recent}</ul>` : '<p class="fine">No stalls. The room has been steady.</p>'}
    <p class="obs-privacy">Live only · metrics stay in memory and are erased when the room closes.</p>`);
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

const canPip = () => 'documentPictureInPicture' in window;
function partyPanelWidth() {
  const width = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar')) || 348;
  return Math.round(Math.max(280, Math.min(520, width)));
}
async function togglePip(opts = {}) {
  if (theaterSvc()) {
    theaterPost({ wpTheater: 'pip', action: opts.keep || !S.theaterPip ? 'open' : 'close', width: partyPanelWidth() });
    return;
  }
  if (S.pipWin) { if (!opts.keep) S.pipWin.close(); return; }
  if (!canPip()) { if (!opts.quiet) toast('The pop-out party needs Chrome, Edge or Brave on a computer.', { timeout: 4000 }); return; }
  try {
    S.pipWin = await window.documentPictureInPicture.requestWindow({ width: partyPanelWidth(), height: 520, preferInitialWindowPlacement: true });
  } catch (e) { if (!opts.quiet) toast('Could not open the pop-out party.', { kind: 'error' }); S.pipWin = null; return; }
  const doc = S.pipWin.document;
  for (const ss of [...document.styleSheets]) {
    try { const st = doc.createElement('style'); st.textContent = [...ss.cssRules].map(r => r.cssText).join('\n'); doc.head.appendChild(st); } catch { /* cross-origin sheet */ }
  }
  const svg = document.querySelector('body > svg');
  if (svg) doc.body.appendChild(svg.cloneNode(true));
  doc.documentElement.dataset.theme = document.documentElement.dataset.theme;
  doc.body.className = 'pip-body';
  doc.title = 'Watch Party';
  const cams = $('#cams');
  doc.body.appendChild(cams);
  placeTiles();
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
  doc.getElementById('popReacts').innerHTML = (S.reactions || []).map(r => `<button type="button" data-emoji="${esc(r)}">${esc(r)}</button>`).join('');
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
  S.pipWin.addEventListener('pagehide', () => {
    stage.appendChild(cams);
    cams.querySelectorAll('video').forEach(v => v.play().catch(() => {}));
    S.pipWin = null;
    $('#pipBtn').classList.remove('live');
    placeTiles();
  });
}
let popChatKey = '';
function popRender(force) {
  if (!S.pipWin) return;
  const doc = S.pipWin.document;
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
    list.innerHTML = S.chatLog.slice(-60).map(c => c.system ? `<div class="m sys">${esc(c.text)}</div>` : `<div class="m"><b style="color:hsl(${hue(c.name)} 70% var(--name-l))">${esc(c.name)}</b>${WpEmoji.chatHtml(c.text)}</div>`).join('');
    list.scrollTop = list.scrollHeight;
  }
}
setInterval(() => popRender(false), 500);
$('#pipBtn').addEventListener('click', () => togglePip());

export { addChat, buildReactions, notificationCenter, openQuickChat, placeTiles, renderBookmarks, renderCams, renderObservatory, renderPeople, renderPeopleDrift, scheduleReaction, sendReaction, setTab, stopLocal, toast, togglePip };
