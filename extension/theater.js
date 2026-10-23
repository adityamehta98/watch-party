// The "watch here" window: your Watch Party on the full page, and the streaming site (Netflix,
// Prime Video, ...) with its own player placed exactly where the movie normally goes. You sign in
// and watch right here, with your own account, and the party keeps everyone in sync.
const partyFrame = document.getElementById('party');
const box = document.getElementById('svcBox');
const svc = document.getElementById('svc');
const notices = document.getElementById('notices');
const noticeTimers = new Map();
let partyPopout = null;

function reportPopout(open, error = '') {
  try { partyFrame.contentWindow.postMessage({ wpTheater: 'pip-state', open: !!open, error }, partyOrigin()); } catch { /* party closed */ }
}

async function setPartyPopout(action, requestedWidth) {
  if (partyPopout) {
    if (action === 'close') partyPopout.close();
    else { try { partyPopout.focus(); } catch { /* browser decides */ } reportPopout(true); }
    return;
  }
  if (action === 'close') { reportPopout(false); return; }
  if (!('documentPictureInPicture' in window)) {
    reportPopout(false, 'The pop-out party needs Chrome, Edge or Brave on a computer.');
    return;
  }
  const width = Math.round(Math.max(280, Math.min(520, Number(requestedWidth) || 348)));
  try {
    partyPopout = await window.documentPictureInPicture.requestWindow({ width, height: 520, preferInitialWindowPlacement: true });
    const doc = partyPopout.document;
    doc.title = 'Watch Party';
    Object.assign(doc.documentElement.style, { width: '100%', height: '100%', background: '#0f1013' });
    Object.assign(doc.body.style, { width: '100%', height: '100%', margin: '0', overflow: 'hidden', background: '#0f1013' });
    const frame = doc.createElement('iframe');
    frame.title = 'Watch Party controls';
    frame.src = chrome.runtime.getURL('sidebar.html?popout=1');
    frame.allow = 'autoplay; camera; microphone';
    Object.assign(frame.style, { width: '100%', height: '100%', border: '0', display: 'block' });
    doc.body.appendChild(frame);
    reportPopout(true);
    partyPopout.addEventListener('pagehide', () => { partyPopout = null; reportPopout(false); }, { once: true });
  } catch {
    partyPopout = null;
    reportPopout(false, 'Could not open the pop-out party. Click the button again and allow pop-outs.');
  }
}

function dismissNotice(id) {
  clearTimeout(noticeTimers.get(id));
  noticeTimers.delete(id);
  const el = [...notices.children].find(x => x.dataset.id === id);
  if (el) el.remove();
}
function showNotice(m) {
  const id = String(m.id || '').slice(0, 80);
  if (!id) return;
  dismissNotice(id);
  const el = document.createElement('div');
  el.className = `notice ${['error', 'knock', 'request'].includes(m.kind) ? m.kind : ''}`;
  el.dataset.id = id;
  const text = document.createElement('span');
  text.textContent = String(m.text || '').slice(0, 500);
  el.appendChild(text);
  const actions = Array.isArray(m.actions) ? m.actions.slice(0, 3) : [];
  if (actions.length) {
    const group = document.createElement('div'); group.className = 'actions';
    actions.forEach((action, index) => {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = String(action.label || '').slice(0, 60);
      if (action.primary) button.className = 'primary';
      button.addEventListener('click', () => {
        partyFrame.contentWindow.postMessage({ wpTheater: 'toast-action', id, index }, partyOrigin());
        dismissNotice(id);
      });
      group.appendChild(button);
    });
    el.appendChild(group);
  }
  notices.appendChild(el);
  while (notices.childElementCount > 4) dismissNotice(notices.firstElementChild.dataset.id);
  const timeout = Math.max(1000, Math.min(30000, Number(m.timeout) || 4000));
  noticeTimers.set(id, setTimeout(() => dismissNotice(id), timeout));
}

function allowedServiceUrl(url, custom) {
  try {
    const u = new URL(url);
    // the host's custom site: any web page, but never the Watch Party itself
    if (custom) return /^https?:$/.test(u.protocol) && !wpServiceOf(u.hostname) && u.origin !== partyOrigin();
    return u.protocol === 'https:' && !!wpServiceOf(u.hostname) && wpServiceOf(u.hostname) !== 'youtube';
  } catch { return false; }
}
function partyOrigin() { try { return new URL(partyUrl).origin; } catch { return ''; } }
// Show a page in the window. A custom site may refuse to be shown inside another page: the extension
// first allows that (for this window only), then the page loads.
let loadSeq = 0, customUrl = '', currentStrict = false;
// Pop-up protection is enforced by the extension background. Do not use the iframe `sandbox`
// attribute here: players can see it and some deliberately refuse to run in a sandboxed frame.
function load(url, custom, strict) {
  const seq = ++loadSeq;
  customUrl = custom ? url : '';
  currentStrict = !!(custom && strict);
  svc.removeAttribute('sandbox');
  // the extension first lets the site load inside this window, then it loads
  frameFailure = '';
  helpClosed = false;
  help.hidden = true;
  const go = result => {
    if (seq !== loadSeq) return;
    if (!result || !result.ok) { showFrameFailure(result?.error || 'The extension could not prepare the player.'); return; }
    svc.src = url;
  };
  chrome.runtime.sendMessage(custom
    ? { wp: 'frame-allow', url, party: partyUrl, blockPopups: currentStrict }
    : { wp: 'theater-hello', party: partyUrl, custom: null, blockPopups: false }).then(go, error => {
      if (seq === loadSeq) showFrameFailure(String(error?.message || error));
    });
}
// Remind the extension now and then that this window is here (and what it shows): the browser puts the
// extension's background part to sleep after a while, and it starts again knowing nothing.
setInterval(() => { chrome.runtime.sendMessage({ wp: 'theater-hello', party: partyUrl, custom: customUrl || null, blockPopups: currentStrict }).catch(() => {}); }, 10000);
const svcOf = u => { try { return wpServiceOf(new URL(u).hostname) || 'custom'; } catch { return ''; } };
function allowedPartyUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' && /^\/join\/[A-Za-z0-9]+\/?$/.test(u.pathname)) return true;
    return u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname) && /^\/host\/[A-Za-z0-9]+\/?$/.test(u.pathname);
  } catch { return false; }
}

const params = new URLSearchParams(location.hash.slice(1));
const partyUrl = params.get('p') || '';
if (!allowedPartyUrl(partyUrl)) {
  document.getElementById('bad').hidden = false;
  document.getElementById('bad').textContent = 'Open your Watch Party invite link first, then choose "Watch here".';
} else {
  const u = new URL(partyUrl);
  u.searchParams.set('theater', '1');
  partyFrame.src = u.toString();
}
chrome.runtime.sendMessage({ wp: 'theater-hello', party: partyUrl }).catch(() => {});

let currentSvcUrl = '', waitingSince = 0, helpClosed = false, lastStage = null, frameFailure = '';
// Keep failures and retry inside the Watch Party window, including while browsing or signing in.
function showFrameFailure(error) {
  frameFailure = String(error || 'The service page did not load.').slice(0, 240);
  checkStuck();
}
function checkStuck() {
  const m = lastStage;
  const stuck = !!(m && m.show && !helpClosed && (frameFailure || (!m.linked && !m.browsing && waitingSince && Date.now() - waitingSince > 90000)));
  help.hidden = !stuck;
  document.getElementById('helpText').textContent = frameFailure
    ? `Could not load the service here: ${frameFailure}` : 'Video has not connected yet. Retry inside Watch Party.';
  if (stuck && m.rect) Object.assign(help.style, { left: `${m.rect.x + 16}px`, top: `${m.rect.y + 16}px` });
}
setInterval(checkStuck, 2000);
const help = document.getElementById('help');
document.getElementById('helpX').addEventListener('click', () => { helpClosed = true; help.hidden = true; });
document.getElementById('helpRetry').addEventListener('click', () => {
  if (!currentSvcUrl || !allowedServiceUrl(currentSvcUrl, !!customUrl)) return;
  waitingSince = Date.now();
  load(currentSvcUrl, !!customUrl, currentStrict);
});
let theaterTabId = null;
chrome.tabs.getCurrent().then(tab => { theaterTabId = tab?.id ?? null; });
chrome.runtime.onMessage.addListener((m, sender) => {
  if (sender.id !== chrome.runtime.id || m?.wp !== 'theater-frame-error' || m.tabId !== theaterTabId || !lastStage?.show) return;
  if (svcOf(m.url) !== svcOf(currentSvcUrl)) return;
  showFrameFailure(m.error);
});
window.addEventListener('message', e => {
  if (e.source !== partyFrame.contentWindow || !e.data || typeof e.data.wpTheater !== 'string') return;
  const m = e.data;
  if (m.wpTheater === 'stage') {
    const show = !!m.show && allowedServiceUrl(m.url, !!m.custom);
    // A Netflix episode change first uses Netflix's own Next control inside the existing frame. Keep
    // this outer frame intact while that native transition is settling so its profile/PIN session is
    // not recreated. The party removes `transitioning` after success or an eight-second fallback.
    const nativeTransition = show && !!m.transitioning && svcOf(m.current || currentSvcUrl) === svcOf(m.url);
    // The room's title changed. If the frame is already on that page (the host clicked it in there
    // and the room followed), leave it alone; reloading would restart the video.
    // Never reload in the middle of signing in (that sent people back to the start of the sign-in, again
    // and again); the party takes them to the title once they're in.
    if (show && !nativeTransition && (m.url !== currentSvcUrl || !!m.strict !== currentStrict)) {
      if (!currentSvcUrl || !!m.strict !== currentStrict) load(m.url, !!m.custom, !!m.strict);
      // (not in the middle of signing in, unless the room switched to another service altogether)
      else if ((!m.signin || svcOf(m.current) !== svcOf(m.url)) && wpCanonicalUrl(m.current) !== wpCanonicalUrl(m.url)) load(m.url, !!m.custom, !!m.strict);
      currentSvcUrl = m.url;
      waitingSince = 0; helpClosed = false;
    }
    box.hidden = !show;
    // the party opened a window (Invite, say): step aside while it's open. The show keeps playing.
    box.style.visibility = m.cover ? 'hidden' : '';
    if (show && m.rect) {
      const r = m.rect;
      Object.assign(box.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    }
    if (!show && currentSvcUrl && !m.keep) { currentSvcUrl = ''; customUrl = ''; currentStrict = false; frameFailure = ''; loadSeq++; svc.src = 'about:blank'; }
    lastStage = { ...m, show };
    if (show && !m.linked) { if (!waitingSince) waitingSince = Date.now(); } else waitingSince = 0;
    checkStuck();
  } else if (m.wpTheater === 'goto') {
    if (allowedServiceUrl(m.url, !!m.custom)) { load(m.url, !!m.custom, !!m.strict); currentSvcUrl = m.url; }
  } else if (m.wpTheater === 'fullscreen') {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else box.requestFullscreen().catch(() => {});
  } else if (m.wpTheater === 'pip') {
    setPartyPopout(m.action, m.width);
  } else if (m.wpTheater === 'title') {
    document.title = String(m.text || 'Watch Party').slice(0, 120);
  } else if (m.wpTheater === 'toast') {
    showNotice(m);
  } else if (m.wpTheater === 'toast-dismiss') {
    dismissNotice(String(m.id || ''));
  } else if (m.wpTheater === 'exit') {
    // back to the normal Watch Party page (the streaming site opens in its own tab from there)
    if (allowedPartyUrl(partyUrl)) location.href = partyUrl.split('#')[0];
  }
});
