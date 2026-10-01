// The party in Chrome's side panel, next to Netflix / Prime Video / ...
// Everything here is a view of the Watch Party tab: it shows what that tab knows and sends your
// clicks back to it. The Watch Party tab stays the one connected to the room.
const $ = s => document.querySelector(s);
let ui = null;
let time = null;
let port = null;
let pc = null, pendingIce = [], camNames = new Map(), streams = new Map();

function connect() {
  port = chrome.runtime.connect({ name: 'dock' });
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => { port = null; setTimeout(connect, 800); });
  chrome.windows.getCurrent(w => send({ type: 'hello', windowId: w && w.id }));
}
function send(m) { if (port) try { port.postMessage(m); } catch { /* reconnecting */ } }
const act = action => send({ type: 'ui-action', action });

function onMessage(m) {
  if (m.type === 'none') { ui = null; $('#none').hidden = false; $('#app').hidden = true; closeRtc(); return; }
  if (m.type === 'bound') { $('#none').hidden = true; $('#app').hidden = false; return; }
  if (m.type === 'ui') { ui = m.ui; $('#none').hidden = true; $('#app').hidden = false; render(); return; }
  if (m.type === 'ui-time') { time = { ...m.t, got: Date.now() }; renderTime(); return; }
  if (m.type === 'dock-rtc') onRtc(m.data || {});
}

// ------------------------------------------------ rendering
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fmt(t) {
  t = Math.max(0, Math.floor(t || 0));
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

let lastChatKey = '', lastPeopleKey = '', lastReactKey = '';
function render() {
  if (!ui) return;
  $('#svc').textContent = ui.movie ? ui.movie.service : 'Watch Party';
  $('#title').textContent = ui.movie ? (ui.movie.title || `Watching on ${ui.movie.service}`) : 'Nothing playing yet';
  for (const id of ['#playBtn', '#backBtn', '#fwdBtn']) $(id).disabled = !ui.canControl;
  $('#seek').classList.toggle('locked', !ui.canControl);
  $('#chatInput').disabled = !ui.canChat;
  $('#chatInput').placeholder = ui.canChat ? 'Say something…' : 'The host turned off chat for you';

  let notice = '';
  if (ui.ad) notice = 'An ad is playing in your tab. The room waits until it\'s over.';
  else if (ui.waiting && ui.waiting.length) notice = `Waiting for ${ui.waiting.join(', ')} to catch up…`;
  else if (ui.movie && !ui.linked && ui.movie.service !== 'Movie' && ui.movie.service !== 'YouTube') notice = `Start the video in the ${ui.movie.service} tab and it links up.`;
  $('#notice').hidden = !notice;
  $('#notice').textContent = notice;

  const cb = $('#camBtn'), mb = $('#micBtn');
  cb.textContent = ui.myCam ? 'Camera on' : 'Camera off'; cb.classList.toggle('on', ui.myCam); cb.disabled = !ui.canCam;
  mb.textContent = ui.myMic ? 'Mic on' : 'Mic off'; mb.classList.toggle('on', ui.myMic); mb.disabled = !ui.canCam;

  const rk = JSON.stringify([ui.reactions, ui.canReact]);
  if (rk !== lastReactKey) {
    lastReactKey = rk;
    $('#reacts').innerHTML = ui.canReact ? ui.reactions.slice(0, 6).map(r => `<button type="button" data-emoji="${esc(r)}" title="React">${esc(r)}</button>`).join('') : '';
  }

  const pk = JSON.stringify(ui.people);
  if (pk !== lastPeopleKey) {
    lastPeopleKey = pk;
    $('#peopleSum').textContent = `Here now · ${ui.people.length}`;
    $('#people').innerHTML = ui.people.map(p => `<div class="person"><i class="dot"></i><span class="nm">${esc(p.name)}${p.me ? ' (you)' : ''}</span>${p.host ? '<span class="tag">HOST</span>' : ''}<span class="ic">${p.cam ? 'cam' : ''}${p.cam && p.mic ? ' · ' : ''}${p.mic ? 'mic' : ''}</span></div>`).join('');
  }

  const ck = JSON.stringify(ui.chat.slice(-3)) + ui.chat.length;
  if (ck !== lastChatKey) {
    lastChatKey = ck;
    const list = $('#chatList');
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    list.innerHTML = ui.chat.map(c => c.system
      ? `<div class="msg system">${esc(c.text)}</div>`
      : `<div class="msg${c.me ? ' me' : ''}"><div class="who">${esc(c.name)}${c.host ? ' · host' : ''}<time>${new Date(c.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></div><div class="body">${esc(c.text)}</div></div>`).join('');
    if (atBottom || (ui.chat.length && ui.chat[ui.chat.length - 1].me)) list.scrollTop = list.scrollHeight;
  }
  renderCams();
  renderTime();
}

function livePos() {
  if (!time) return 0;
  return time.pos + (time.playing ? (Date.now() - time.got) / 1000 : 0);
}
function renderTime() {
  if (!time) return;
  const pos = livePos(), dur = time.dur || 0;
  $('#time').textContent = `${fmt(pos)} / ${fmt(dur)}`;
  $('#seekFill').style.width = dur ? `${Math.min(100, pos / dur * 100)}%` : '0';
  const want = time.playing ? 'pause' : 'play';
  const icon = $('#playIcon');
  if (icon.dataset.k !== want) {
    icon.dataset.k = want;
    icon.innerHTML = want === 'pause' ? '<path d="M8 5v14M16 5v14" stroke-width="3.2"/>' : '<path d="M7 5v14l12-7z" class="fill"/>';
  }
}
setInterval(renderTime, 500);

// ------------------------------------------------ cameras (sent over from the Watch Party tab)
function renderCams() {
  const box = $('#cams');
  const want = (ui && ui.cams) || [];
  const ids = new Set(want.map(c => c.sid));
  for (const el of [...box.children]) if (!ids.has(el.dataset.sid)) el.remove();
  for (const c of want) {
    let el = box.querySelector(`[data-sid="${CSS.escape(c.sid)}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'cam' + (c.self ? ' self' : '');
      el.dataset.sid = c.sid;
      el.innerHTML = '<video autoplay playsinline muted></video><span></span>';
      box.appendChild(el);
    }
    el.querySelector('span').textContent = c.name;
    const v = el.querySelector('video');
    const s = streams.get(c.sid);
    if (s && v.srcObject !== s) { v.srcObject = s; v.play().catch(() => {}); }
  }
}
function closeRtc() { if (pc) try { pc.close(); } catch {} pc = null; streams.clear(); pendingIce = []; }
async function onRtc(d) {
  try {
    if (d.none) { closeRtc(); renderCams(); return; }
    if (d.sdp && d.sdp.type === 'offer') {
      closeRtc();
      const conn = new RTCPeerConnection();
      pc = conn;
      conn.ontrack = e => {
        const s = e.streams && e.streams[0];
        if (!s) return;
        streams.set(s.id, s);
        renderCams();
      };
      conn.onicecandidate = e => { if (e.candidate && pc === conn) send({ type: 'dock-rtc', data: { ice: e.candidate.toJSON() } }); };
      conn.onconnectionstatechange = () => { if (conn.connectionState === 'failed' && pc === conn) send({ type: 'dock-rtc', data: { restart: true } }); };
      await conn.setRemoteDescription(d.sdp);
      await conn.setLocalDescription(await conn.createAnswer());
      send({ type: 'dock-rtc', data: { sdp: { type: conn.localDescription.type, sdp: conn.localDescription.sdp } } });
      for (const c of pendingIce.splice(0)) await conn.addIceCandidate(c).catch(() => {});
    } else if (d.ice) {
      if (!pc || !pc.remoteDescription) pendingIce.push(d.ice);
      else await pc.addIceCandidate(d.ice).catch(() => {});
    }
  } catch (e) { console.warn('cameras', e); }
}

// ------------------------------------------------ your clicks
$('#playBtn').addEventListener('click', () => act({ op: 'toggle' }));
$('#backBtn').addEventListener('click', () => act({ op: 'seek-by', by: -10 }));
$('#fwdBtn').addEventListener('click', () => act({ op: 'seek-by', by: 10 }));
$('#seek').addEventListener('click', e => {
  if (!ui || !ui.canControl || !time || !time.dur) return;
  const r = e.currentTarget.getBoundingClientRect();
  act({ op: 'seek-to', t: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * time.dur });
});
$('#camBtn').addEventListener('click', () => act({ op: 'cam' }));
$('#micBtn').addEventListener('click', () => act({ op: 'mic' }));
$('#reacts').addEventListener('click', e => { const b = e.target.closest('[data-emoji]'); if (b) act({ op: 'react', emoji: b.dataset.emoji }); });
$('#chatForm').addEventListener('submit', e => {
  e.preventDefault();
  const i = $('#chatInput');
  const text = i.value.trim();
  if (!text) return;
  act({ op: 'chat', text });
  i.value = '';
});
$('#partyBtn').addEventListener('click', () => send({ type: 'party-tab' }));
$('#bigBtn').addEventListener('click', () => send({ type: 'big-screen' }));
document.addEventListener('keydown', e => {
  if (e.target.closest('input')) return;
  if (e.key === ' ' || e.key === 'k') { e.preventDefault(); act({ op: 'toggle' }); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); act({ op: 'seek-by', by: -10 }); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); act({ op: 'seek-by', by: 10 }); }
});

connect();
