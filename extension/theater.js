// The "watch here" window: your Watch Party on the full page, and the streaming site (Netflix,
// Prime Video, ...) with its own player placed exactly where the movie normally goes. You sign in
// and watch right here, with your own account, and the party keeps everyone in sync.
const partyFrame = document.getElementById('party');
const box = document.getElementById('svcBox');
const svc = document.getElementById('svc');

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
  const go = () => { if (seq === loadSeq) svc.src = url; };
  chrome.runtime.sendMessage(custom
    ? { wp: 'frame-allow', url, party: partyUrl, blockPopups: currentStrict }
    : { wp: 'theater-hello', party: partyUrl, custom: null, blockPopups: false }).then(go, go);
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

let currentSvcUrl = '', waitingSince = 0, helpClosed = false, lastStage = null;
// not playing here after a while (a site might refuse to run inside another window): offer the old way
function checkStuck() {
  const m = lastStage;
  // only after a good while (signing in takes time), and never while the host is still picking something
  const stuck = !!(m && m.show && !m.linked && !m.browsing && waitingSince && Date.now() - waitingSince > 90000 && !helpClosed);
  help.hidden = !stuck;
  if (stuck && m.rect) Object.assign(help.style, { left: `${m.rect.x + 16}px`, top: `${m.rect.y + 16}px` });
}
setInterval(checkStuck, 2000);
const help = document.getElementById('help');
document.getElementById('helpText').textContent = 'Video not starting here?';
document.getElementById('helpX').addEventListener('click', () => { helpClosed = true; help.hidden = true; });
document.getElementById('helpTab').addEventListener('click', () => { if (allowedPartyUrl(partyUrl)) location.href = partyUrl.split('#')[0]; });
window.addEventListener('message', e => {
  if (e.source !== partyFrame.contentWindow || !e.data || typeof e.data.wpTheater !== 'string') return;
  const m = e.data;
  if (m.wpTheater === 'stage') {
    const show = !!m.show && allowedServiceUrl(m.url, !!m.custom);
    // The room's title changed. If the frame is already on that page (the host clicked it in there
    // and the room followed), leave it alone; reloading would restart the video.
    // Never reload in the middle of signing in (that sent people back to the start of the sign-in, again
    // and again); the party takes them to the title once they're in.
    if (show && (m.url !== currentSvcUrl || !!m.strict !== currentStrict)) {
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
    if (!show && currentSvcUrl && !m.keep) { currentSvcUrl = ''; customUrl = ''; currentStrict = false; loadSeq++; svc.src = 'about:blank'; }
    lastStage = { ...m, show };
    if (show && !m.linked) { if (!waitingSince) waitingSince = Date.now(); } else waitingSince = 0;
    checkStuck();
  } else if (m.wpTheater === 'goto') {
    if (allowedServiceUrl(m.url, !!m.custom)) { load(m.url, !!m.custom, !!m.strict); currentSvcUrl = m.url; }
  } else if (m.wpTheater === 'fullscreen') {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else box.requestFullscreen().catch(() => {});
  } else if (m.wpTheater === 'title') {
    document.title = String(m.text || 'Watch Party').slice(0, 120);
  } else if (m.wpTheater === 'exit') {
    // back to the normal Watch Party page (the streaming site opens in its own tab from there)
    if (allowedPartyUrl(partyUrl)) location.href = partyUrl.split('#')[0];
  }
});
