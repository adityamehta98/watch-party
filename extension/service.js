// Runs on streaming sites (in every frame). Finds the main video, reports where it is, and follows
// play / pause / seek commands from the Watch Party. Your own clicks in the player are shared too.
(() => {
  if (window.__wpService) return;
  window.__wpService = true;
  // a known service, or the custom site the host opened in the Watch Party window (see custom-gate.js)
  const SERVICE = wpServiceOf(location.hostname) || (window.__wpCustom ? 'custom' : null);
  if (!SERVICE) return;
  // The site's own page: normally the top of the tab, or the frame inside the Watch Party's "watch here" window.
  const TOP = window === window.top || !!(location.ancestorOrigins && location.ancestorOrigins.length === 1 && /^chrome-extension:/.test(location.ancestorOrigins[0]));
  const NETFLIX = SERVICE === 'netflix';
  const send = m => { try { chrome.runtime.sendMessage(m).catch(() => {}); } catch { /* extension was reloaded */ } };

  let video = null;          // the element we control
  let switchedAt = 0;        // when we last picked a different element
  let maxDur = 0;            // longest real video seen here (to tell ads apart)
  const expect = { play: 0, pause: 0, seek: 0 }; // until when an event of this kind was caused by us, not the viewer
  let blocked = false;
  let lastContent = { t: 0, rate: 1 }; // where the show was before an ad took over
  let contentVideo = null;              // the element playing the show itself (the longest video)

  // ------------------------------------------------ find the main video
  function videos() {
    const out = [...document.querySelectorAll('video')];
    if (SERVICE === 'disney' || out.length === 0) {
      // some players (Disney+) hide the video inside shadow DOM
      const walk = root => root.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) { out.push(...el.shadowRoot.querySelectorAll('video')); walk(el.shadowRoot); }
      });
      try { walk(document); } catch { /* ignore */ }
    }
    return out;
  }
  function area(v) { const r = v.getBoundingClientRect(); return Math.max(0, r.width) * Math.max(0, r.height); }
  function pick() {
    let best = null, bestScore = 0;
    for (const v of videos()) {
      const a = area(v);
      if (a < 160 * 90) continue;
      const score = a * (v.readyState > 0 ? 2 : 1) * (v.duration > 60 ? 2 : 1);
      if (score > bestScore) { best = v; bestScore = score; }
    }
    if (best !== video) {
      if (video) for (const ev of ['play', 'pause', 'seeking', 'seeked']) video.removeEventListener(ev, onUserEvent);
      if (video) video.removeEventListener('volumechange', onVolumeChange);
      video = best;
      switchedAt = performance.now();
      if (video) for (const ev of ['play', 'pause', 'seeking', 'seeked']) video.addEventListener(ev, onUserEvent);
      if (video) video.addEventListener('volumechange', onVolumeChange);
    }
    return video;
  }

  function isAd(v) {
    if (SERVICE === 'youtube' && document.querySelector('.ad-showing')) return true;
    const d = v.duration;
    // a much shorter video suddenly playing in place of the movie is almost always an ad break
    return isFinite(d) && d > 0 && maxDur > 90 && d < Math.min(300, maxDur * 0.5);
  }

  // The show's name, for the party (and for friends on phones, who follow along by hand).
  // Players only show it while their controls are up, so remember it for the page once seen.
  const TITLE_SELECTORS = [
    '[data-uia="video-title"]',                                           // Netflix
    '.atvwebplayersdk-title-text', '.atvwebplayersdk-subtitle-text',       // Prime Video
    '.PlayerMetadata__titleText', '.PlayerMetadata__subTitle',             // Hulu
    '[data-testid="player-ux-asset-title"]', '[data-testid="player-ux-asset-subtitle"]', // Max
    '.title-field', '.subtitle-field',                                     // Disney+
    '[data-t="player-title"]', '.show-title-link', '.title-heading',       // others
  ];
  const seenTitles = new Map();
  function title() {
    const key = location.pathname;
    const parts = [];
    for (const sel of TITLE_SELECTORS) {
      const el = document.querySelector(sel);
      const t = el && el.textContent.trim().replace(/\s+/g, ' ');
      if (t && !parts.includes(t) && t.length < 140) parts.push(t);
      if (parts.length >= 2) break;
    }
    if (parts.length) { seenTitles.set(key, parts.join(' · ')); }
    if (seenTitles.has(key)) return seenTitles.get(key);
    const og = document.querySelector('meta[property="og:title"]');
    let t = (og && og.content) || document.title || '';
    t = t.replace(/\s*[|\-–]\s*(Netflix|Prime Video|Amazon\.com.*|Hulu|Peacock|Crunchyroll|Paramount\+|Max|HBO Max|Disney\+|Apple TV\+|YouTube)\s*$/i, '');
    t = t.replace(/^(Watch|Stream)\s+/i, '').trim();
    if (/^(Netflix|Prime Video|Hulu|Peacock|Crunchyroll|Paramount\+|Max|Disney\+|Apple TV\+|Home)$/i.test(t)) t = '';
    return t.slice(0, 140);
  }

  // ------------------------------------------------ report status
  function status() {
    const v = pick();
    if (!v) return null;
    const ad = isAd(v);
    const d = isFinite(v.duration) ? v.duration : 0;
    if (!ad && d > 0 && d >= maxDur) { maxDur = d; contentVideo = v; }
    // only the show's own video may update the show's position (a new ad element starts at 0)
    if (!ad && v === contentVideo) lastContent = { t: v.currentTime, rate: v.playbackRate };
    const fresh = v !== contentVideo && performance.now() - switchedAt < 3000 && !(d > 0);
    if (fresh) return null; // a new video that hasn't loaded yet: wait until we know what it is
    // During an ad, report the show's position (not the ad's), so the room simply waits.
    return {
      service: SERVICE, t: ad ? lastContent.t : v.currentTime, paused: ad ? false : v.paused, rate: ad ? lastContent.rate : v.playbackRate, dur: ad ? maxDur : d,
      buffering: !v.paused && v.readyState < 3, ad, blocked, title: TOP ? title() : '', area: area(v), root: TOP, url: TOP ? location.href : '',
      vol: v.volume, muted: v.muted, hold: userBusy(),
    };
  }
  setInterval(() => {
    const st = status();
    if (st) send({ wp: 'status', st });
  }, 250);

  // Which page this tab is on, even when there's no video yet (signing in, picking a profile,
  // browsing). The party uses it to avoid reloading you in the middle of signing in, and to take
  // you to the room's title once you're in.
  function signingIn() {
    if (/\/(login|signin|sign-in|sign_in|auth|ap\/signin|profiles|ProfilesGate|welcome|register|account\/profile)/i.test(location.pathname + location.search)) return true;
    if (document.querySelector('input[type="password"], input[autocomplete="one-time-code"], [data-uia*="pin" i], [data-uia*="profile-gate" i], .profiles-gate-container, .list-profiles')) return true;
    const h = (document.querySelector('h1, h2') || {}).textContent || '';
    return /who'?s watching|who is watching|profile lock|enter your pin|choose (a|your) profile/i.test(h);
  }
  let lastPage = '', lastPageAt = 0;
  if (TOP) setInterval(() => {
    const info = { url: location.href, signin: signingIn() };
    const key = info.url + '|' + info.signin;
    if (key === lastPage && Date.now() - lastPageAt < 5000) return;
    lastPage = key; lastPageAt = Date.now();
    send({ wp: 'page', service: SERVICE, ...info });
  }, 1000);

  // viewer used the service's own buttons: share it with the room.
  // A jump is shared the moment it starts ("seeking"), not when the site has finished loading the new
  // spot, which on Netflix can take seconds (meanwhile the party would have "corrected" it back).
  // Players also pause and play again by themselves while they jump; those blips are not the viewer
  // pressing pause, so play/pause is sent only once the player has settled, and only if it changed.
  let seekBusy = false, seekStartAt = 0, seekDoneAt = 0, seekOurs = false;
  let pendingPP = null; // { before: was it paused before, timer, since }
  // After the viewer jumps, the site takes a moment to load the new spot while the room moves on.
  // Once it really plays again, tell the room where it landed, so everyone lines up with this screen
  // instead of this screen jumping again to catch up (which would load all over again).
  let landing = null, wasPlaying = false;
  setInterval(() => {
    const now = performance.now();
    if (video && !settling(now) && !pendingPP && !landing) wasPlaying = !video.paused;
    if (!landing) return;
    if (!video || now - landing.since > 8000) { landing = null; return; }
    if (!video.seeking && !video.paused && video.readyState >= 3) {
      if (now - landing.since > 600 && !isAd(video)) send({ wp: 'user', service: SERVICE, url: TOP ? location.href : '', action: 'seek', t: video.currentTime, land: true });
      landing = null;
    }
  }, 150);
  const settling = now => (seekBusy && now - seekStartAt < 8000) || now - seekDoneAt < 700;
  function onUserEvent(e) {
    if (!video || e.target !== video) return;
    const now = performance.now();
    if (e.type === 'seeking') {
      seekBusy = true; seekStartAt = now;
      seekOurs = now < expect.seek;
      if (seekOurs || now - switchedAt < 2000 || isAd(video)) return;
      sendUserSeek();
      if (wasPlaying) landing = { since: now };
      return;
    }
    if (e.type === 'seeked') {
      seekBusy = false; seekDoneAt = now;
      // our own jump: the pause/play the player does as it lands is ours too
      if (seekOurs) { expect.play = Math.max(expect.play, now + 700); expect.pause = Math.max(expect.pause, now + 700); }
      return;
    }
    const action = e.type; // play / pause
    if (now < expect[action] || now - switchedAt < 2000 || isAd(video)) return;
    if (seekOurs && settling(now)) return;
    if (!pendingPP) pendingPP = { before: action !== 'pause', since: now };
    clearTimeout(pendingPP.timer);
    pendingPP.timer = setTimeout(flushPlayPause, 350);
  }
  // Pressing the site's own skip several times quickly: tell the room at once, then once more where
  // the burst ends (at most every 300 ms), so everyone else loads one spot instead of every one between.
  const userSeekOut = { at: -1e9, timer: null };
  function sendUserSeek() {
    const go = () => {
      userSeekOut.timer = null; userSeekOut.at = performance.now();
      if (video && !isAd(video)) send({ wp: 'user', service: SERVICE, url: TOP ? location.href : '', action: 'seek', t: video.currentTime });
    };
    const now = performance.now();
    if (!userSeekOut.timer && now - userSeekOut.at >= 300) go();
    else if (!userSeekOut.timer) userSeekOut.timer = setTimeout(go, Math.max(30, 300 - (now - userSeekOut.at)));
  }
  function flushPlayPause() {
    const p = pendingPP;
    if (!p) return;
    const now = performance.now();
    // right after a jump, a pause is usually the site loading the new spot: give it a few seconds to play on
    const loadingAfterJump = video && !seekOurs && video.paused && !p.before && now - seekStartAt < 3000;
    if (video && (settling(now) || loadingAfterJump) && now - p.since < 8000) { p.timer = setTimeout(flushPlayPause, 200); return; }
    pendingPP = null;
    if (!video || isAd(video) || video.paused === p.before) return; // paused and played again: nothing changed
    landing = null;
    send({ wp: 'user', service: SERVICE, url: TOP ? location.href : '', action: video.paused ? 'pause' : 'play', t: video.currentTime });
  }
  // "the viewer is doing something here": the party holds off correcting this tab for a moment
  const userBusy = () => !!pendingPP || !!landing || (!seekOurs && settling(performance.now()));

  // ------------------------------------------------ volume: the same level in the party and in the site
  // The party's level is applied to every video the site shows (the show, the next episode, the
  // previews on the home page). Changing it with the site's own slider or keys changes the party's too.
  let wantVol = null, wantMuted = null, volOursUntil = 0, volFor = null, volForAt = 0;
  function setVolume() {
    const v = video;
    if (!v || (wantVol == null && wantMuted == null)) return;
    volOursUntil = performance.now() + 700;
    try {
      if (NETFLIX) { if (wantVol != null) netflix('volume', wantVol); if (wantMuted != null) netflix('mute', wantMuted); }
      else { if (wantVol != null) v.volume = wantVol; if (wantMuted != null) v.muted = wantMuted; }
    } catch { /* not ready yet */ }
  }
  function applyLevelOnly() {
    const m = wantMuted;
    if (m === false) wantMuted = null;
    setVolume();
    wantMuted = m;
  }
  function onVolumeChange(e) {
    const now = performance.now();
    if (e.target !== video || now < volOursUntil || isAd(video)) return;
    // a new video sets its own level while it starts: ours wins for its first few seconds
    if (volFor !== video || now - volForAt < 3000) { if (wantVol != null && Math.abs(video.volume - wantVol) > 0.02) applyLevelOnly(); return; }
    wantVol = video.volume; wantMuted = video.muted;
    send({ wp: 'user', service: SERVICE, url: TOP ? location.href : '', action: 'volume', vol: video.volume, muted: video.muted });
  }
  setInterval(() => {
    if (!video || (wantVol == null && wantMuted == null) || isAd(video) || video.readyState < 1) return;
    // (a new video is never un-muted by us: browsers may stop a video that gets its sound turned on
    // without a click, and the home page's previews start muted on purpose)
    if (volFor !== video) { volFor = video; volForAt = performance.now(); applyLevelOnly(); return; }
    if (performance.now() - volForAt < 3000 && ((wantVol != null && Math.abs(video.volume - wantVol) > 0.02) || (wantMuted === true && !video.muted))) applyLevelOnly();
  }, 300);

  // ------------------------------------------------ follow commands
  function netflix(op, t) { window.postMessage({ source: 'wp-cs', op, t }, location.origin); }
  function apply(c) {
    const v = pick();
    if (!v) return;
    if (isAd(v) && c.op !== 'volume' && c.op !== 'mute') return; // leave ads alone; the room waits
    // only the kind of event we asked for is ours; a pause right after we pressed play is still the viewer's
    const until = performance.now() + 1500;
    if (c.op === 'play') expect.play = until;
    else if (c.op === 'pause') expect.pause = until;
    else if (c.op === 'seek') { expect.seek = until; expect.play = Math.max(expect.play, until); expect.pause = Math.max(expect.pause, until); }
    try {
      switch (c.op) {
        case 'play':
          if (NETFLIX) netflix('play');
          else { const p = v.play(); if (p) p.then(() => { blocked = false; }).catch(err => { if (err && err.name === 'NotAllowedError') blocked = true; }); }
          break;
        case 'pause': if (NETFLIX) netflix('pause'); else v.pause(); break;
        case 'seek': if (NETFLIX) netflix('seek', c.t); else v.currentTime = c.t; break;
        case 'rate': v.playbackRate = Math.max(0.5, Math.min(2, Number(c.r) || 1)); break;
        case 'volume': wantVol = Math.max(0, Math.min(1, Number(c.v))); if (!Number.isFinite(wantVol)) wantVol = null; setVolume(); break;
        case 'mute': wantMuted = !!c.m; setVolume(); break;
        default:
      }
    } catch { /* player not ready */ }
  }
  chrome.runtime.onMessage.addListener(m => {
    if (!m) return;
    if (m.wp === 'cmd') apply(m.cmd);
    else if (!TOP) return;
    else if (m.wp === 'overlay') { if (!m.dockOpen || document.fullscreenElement) overlay(m.item); } // the side panel already shows chat
  });

  // ------------------------------------------------ chat and reactions on top of the player
  let box = null;
  function overlay(item) {
    if (!item) return;
    const host = document.fullscreenElement || document.body;
    if (!box) {
      box = document.createElement('div');
      box.setAttribute('style', 'position:fixed;top:16px;right:16px;z-index:2147483647;display:flex;flex-direction:column;gap:6px;align-items:flex-end;pointer-events:none;font:600 15px/1.35 system-ui,Segoe UI,sans-serif;max-width:40vw');
    }
    if (box.parentNode !== host) host.appendChild(box);
    const el = document.createElement('div');
    el.setAttribute('style', 'background:rgba(0,0,0,.72);color:#fff;padding:7px 12px;border-radius:12px;box-shadow:0 6px 18px rgba(0,0,0,.4);transition:opacity .6s;overflow-wrap:anywhere');
    if (item.kind === 'react') { el.style.fontSize = '30px'; el.style.padding = '4px 10px'; el.textContent = `${item.emoji}`; el.title = item.name; }
    else {
      const b = document.createElement('b'); b.style.color = '#f5b544'; b.textContent = `${item.name}: `;
      el.appendChild(b); el.appendChild(document.createTextNode(String(item.text || '').slice(0, 300)));
    }
    box.appendChild(el);
    while (box.childElementCount > 5) box.firstElementChild.remove();
    setTimeout(() => { el.style.opacity = '0'; }, item.kind === 'react' ? 2000 : 7000);
    setTimeout(() => el.remove(), item.kind === 'react' ? 2700 : 7700);
  }
})();

// ------------------------------------------------ the party's buttons on top of the player
// A small bar you can drag anywhere, even in fullscreen: camera, microphone, chat, and everyone's
// faces. It talks to your Watch Party tab (or the Watch Party window), which does the real work.
(() => {
  const SERVICE = wpServiceOf(location.hostname) || (window.__wpCustom ? 'custom' : null);
  let extensionOrigin = '';
  try { extensionOrigin = new URL(chrome.runtime.getURL('/')).origin; } catch { /* reloaded */ }
  const TOP = window === window.top || !!(location.ancestorOrigins && location.ancestorOrigins.length === 1 && location.ancestorOrigins[0] === extensionOrigin);
  if (!SERVICE || !TOP || window.__wpBar) return;
  window.__wpBar = true;

  let port = null, ui = null, bound = false, inWindow = false;
  // each service's own color for the "on" buttons (text color picked so it stays readable)
  const BRAND = {
    netflix: ['#e50914', '#fff'], prime: ['#1399ff', '#fff'], hulu: ['#1ce783', '#06140c'], peacock: ['#f5c518', '#1a1300'],
    crunchyroll: ['#f47521', '#fff'], paramount: ['#0064ff', '#fff'], max: ['#002be7', '#fff'], disney: ['#1f4fe0', '#fff'],
    appletv: ['#f2f2f7', '#111'], youtube: ['#ff0033', '#fff'],
  }[SERVICE] || ['#f5b544', '#1a1300'];
  let host = null, root = null, chatOpen = false, facesOpen = true;
  let pc = null, pendingIce = [], streams = new Map();
  const POS_KEY = 'wpBarPos';

  function connect() {
    try { port = chrome.runtime.connect({ name: 'dock' }); } catch { return; }
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => { port = null; bound = false; render(); setTimeout(connect, 1500); });
    port.postMessage({ type: 'hello', player: true });
  }
  const send = m => { if (port) try { port.postMessage(m); } catch { /* reconnecting */ } };
  const act = action => send({ type: 'ui-action', action });

  function onMessage(m) {
    if (m.type === 'none') { bound = false; ui = null; closeRtc(); render(); return; }
    if (m.type === 'bound') { bound = true; inWindow = !!m.theater; render(); if (facesOpen) send({ type: 'want-cams' }); return; }
    if (m.type === 'ui') { ui = m.ui; bound = true; render(); return; }
    if (m.type === 'dock-rtc') onRtc(m.data || {});
  }

  // Two fingers sideways on a trackpad, over the show: skip 20 seconds for everyone (the party does
  // the skip, so the whole room moves together). Only while this page is linked to a party and a big
  // video is showing, so rows of titles on the service's home page still scroll normally.
  (() => {
    let sum = 0, lastWheel = 0, fired = false, total = 0, totalAt = 0, osd = null, osdTimer = null;
    const bigVideo = () => [...document.querySelectorAll('video')].some(v => { const r = v.getBoundingClientRect(); return r.width * r.height > innerWidth * innerHeight * 0.35; });
    const show = text => {
      if (!osd) {
        osd = document.createElement('div');
        osd.setAttribute('style', 'all:initial;position:fixed;left:50%;top:42%;transform:translate(-50%,-50%);z-index:2147483647;pointer-events:none;background:rgba(0,0,0,.66);color:#fff;font:700 26px/1 system-ui,Segoe UI,sans-serif;padding:14px 20px;border-radius:16px;transition:opacity .3s');
      }
      const where = document.fullscreenElement || document.documentElement;
      if (osd.parentNode !== where) where.appendChild(osd);
      osd.textContent = text; osd.style.opacity = '1';
      clearTimeout(osdTimer); osdTimer = setTimeout(() => { osd.style.opacity = '0'; }, 800);
    };
    const skip = by => {
      const now = performance.now();
      total = (now - totalAt < 1500 ? total : 0) + by; totalAt = now;
      show(`${total >= 0 ? '+' : '\u2212'}${Math.abs(total)} s`);
      act({ op: 'seek-by', by });
    };
    // Finger swipes on a touch screen (touch laptops too). On the player page the browser is told not to
    // treat sideways finger moves as scrolling or "go back", so they reach us; up/down still scroll.
    const style = document.createElement('style');
    style.textContent = 'html.wp-swipe, html.wp-swipe body { overscroll-behavior-x: none !important; } html.wp-swipe body *:not(input):not([role="slider"]):not([data-uia*="timeline" i]):not([class*="timeline" i]):not([class*="scrubber" i]):not([class*="seekbar" i]):not([class*="slider" i]) { touch-action: pan-y pinch-zoom !important; }';
    (document.head || document.documentElement).appendChild(style);
    setInterval(() => document.documentElement.classList.toggle('wp-swipe', bound && bigVideo()), 1000);
    // the site's own timeline and buttons keep working with a finger: nothing on them counts as a swipe
    const SITE_CONTROLS = 'input, textarea, select, button, a, [role="slider"], [role="progressbar"], [role="button"], [data-uia*="timeline" i], [class*="timeline" i], [class*="scrubber" i], [class*="progress" i], [class*="seekbar" i], [class*="seek-bar" i], [class*="slider" i]';
    const noSwipe = t => !!(t && t.closest && t.closest(SITE_CONTROLS));
    // Fingers: touch events where the device has them (phones, tablets, touch laptops), where a sideways
    // move can be claimed so the browser doesn't also scroll or go back; pens and others: pointer events.
    let sw = null;
    const begin = (x, y, target, path, id) => {
      sw = null;
      // the bottom of the player is where every service puts its timeline and buttons: leave it to them
      if (y > innerHeight * 0.8 || y < innerHeight * 0.08) return;
      if (!bound || noSwipe(target) || (host && path.includes(host)) || !bigVideo()) return;
      sw = { id, x, y, at: performance.now(), claimed: false };
    };
    const finish = (x, y, id) => {
      const st = sw; sw = null;
      if (!st || st.id !== id) return;
      const dx = x - st.x, dy = y - st.y;
      if (Math.abs(dx) < Math.max(40, Math.min(100, innerWidth * 0.08)) || Math.abs(dx) < Math.abs(dy) * 1.3 || performance.now() - st.at > 1200) return;
      skip(dx > 0 ? 20 : -20);
    };
    window.addEventListener('touchstart', e => { if (e.touches.length === 1) begin(e.touches[0].clientX, e.touches[0].clientY, e.target, e.composedPath(), 'touch'); else sw = null; }, { capture: true, passive: true });
    window.addEventListener('touchmove', e => {
      if (!sw || sw.id !== 'touch' || e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - sw.x, dy = e.touches[0].clientY - sw.y;
      if (!sw.claimed && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) sw.claimed = true;
      if (sw.claimed && e.cancelable) { e.preventDefault(); e.stopPropagation(); } // sideways is ours: the site doesn't also scrub or scroll
    }, { capture: true, passive: false });
    window.addEventListener('touchend', e => { if (e.changedTouches.length) finish(e.changedTouches[0].clientX, e.changedTouches[0].clientY, 'touch'); }, { capture: true, passive: true });
    window.addEventListener('touchcancel', () => { sw = null; }, { capture: true, passive: true });
    const hasTouchEvents = 'ontouchstart' in window;
    window.addEventListener('pointerdown', e => { if (e.pointerType === 'mouse' || !e.isPrimary || (e.pointerType === 'touch' && hasTouchEvents)) return; begin(e.clientX, e.clientY, e.target, e.composedPath(), e.pointerId); }, true);
    window.addEventListener('pointerup', e => { if (sw && sw.id === e.pointerId) finish(e.clientX, e.clientY, e.pointerId); }, true);
    // ---------------- skip intros / recaps / credits and go to the next episode (host's tab only)
    // The service's own buttons are pressed, as you would; the room follows this tab like any skip.
    const SKIP_SELECTORS = [
      '[data-uia="player-skip-intro"]', '[data-uia="player-skip-recap"]', '[data-uia="player-skip-preplay"]', // Netflix
      '.atvwebplayersdk-skipelement-button',                                                                 // Prime Video
      '[data-testid="player-ux-skip-button"]',                                                               // Max
      '.skip__button', '[class*="SkipButton"] button', 'button[class*="SkipButton"]', '.skip-button', '.playback-skip-intro',
    ];
    const NEXT_SELECTORS = [
      '[data-uia="next-episode-seamless-button"]', '[data-uia="next-episode-seamless-button-draining"]',       // Netflix
      '.atvwebplayersdk-nextupcard-button', '[class*="nextupcard-button"]',                                   // Prime Video
      '[data-testid="player-ux-up-next-button"]', '[data-testid="up-next-play-button"]',                      // Max, Disney+
      '[data-automationid="endcard-play-button"]',
    ];
    const SKIP_TEXT = /^\s*skip\s+(the\s+)?(intro|recap|opening|credits|ending|outro|preview|summary)s?\s*$/i;
    const NEXT_TEXT = /^\s*(next episode|play next( episode)?|watch next|start next episode)\s*$/i;
    const NEVER = /watch credits|\bads?\b|advert|sponsor/i;
    // a button we pressed counts as pressed until it goes away (sites reuse the same button next time)
    const clicked = new Set();
    const forgetGone = () => { for (const el of clicked) if (!el.isConnected || !visible(el)) clicked.delete(el); };
    let lastAuto = 0;
    const visible = el => { const r = el.getBoundingClientRect(); if (r.width < 8 || r.height < 8) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.05; };
    const label = el => (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
    const allButtons = () => {
      const out = [...document.querySelectorAll('button, [role="button"]')];
      if (SERVICE === 'disney') document.querySelectorAll('*').forEach(el => { if (el.shadowRoot) out.push(...el.shadowRoot.querySelectorAll('button, [role="button"]')); });
      return out;
    };
    const nearEnd = () => { const v = [...document.querySelectorAll('video')].find(x => x.duration > 60); return !!v && (v.duration - v.currentTime < 300 || v.currentTime / v.duration > 0.9); };
    const findAuto = () => {
      for (const sel of SKIP_SELECTORS) for (const el of document.querySelectorAll(sel)) if (!clicked.has(el) && visible(el) && !NEVER.test(label(el))) return { el, what: /recap|summary/i.test(label(el)) ? 'Skipped the recap' : /credit|ending|outro/i.test(label(el)) ? 'Skipped the credits' : 'Skipped the intro' };
      if (nearEnd()) for (const sel of NEXT_SELECTORS) for (const el of document.querySelectorAll(sel)) if (!clicked.has(el) && visible(el) && !NEVER.test(label(el))) return { el, what: 'Next episode' };
      for (const el of allButtons()) {
        if (clicked.has(el) || !visible(el)) continue;
        const t = label(el);
        if (!t || t.length > 40 || NEVER.test(t)) continue;
        if (SKIP_TEXT.test(t)) return { el, what: /recap|summary/i.test(t) ? 'Skipped the recap' : /credit|ending|outro/i.test(t) ? 'Skipped the credits' : 'Skipped the intro' };
        // "Next episode" also sits in the player's control bar all the time: only near the end, and
        // not the one in the controls (Netflix's is data-uia="control-next")
        if (NEXT_TEXT.test(t) && nearEnd() && !el.closest('[data-uia="control-next"], [data-uia*="controls-standard"]')) return { el, what: 'Next episode' };
      }
      return null;
    };
    setInterval(() => {
      if (!bound || !ui || !ui.autoSkip || !bigVideo()) return;
      forgetGone();
      const now = performance.now();
      if (now - lastAuto < 2500) return;
      const hit = findAuto();
      if (!hit) return;
      clicked.add(hit.el); lastAuto = now;
      try { hit.el.click(); } catch { return; }
      show(hit.what === 'Next episode' ? 'Next episode' : hit.what.replace('Skipped the ', 'Skipped ').replace(/^./, c => c.toUpperCase()));
      act({ op: 'auto-skipped', what: hit.what });
    }, 600);

    window.addEventListener('wheel', e => {
      if (!bound || e.ctrlKey || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      if (host && e.composedPath().includes(host)) return;
      if (!bigVideo()) return;
      e.preventDefault(); e.stopPropagation();
      const now = performance.now();
      if (now - lastWheel > 500) { sum = 0; fired = false; }
      lastWheel = now;
      if (fired) return;
      sum += e.deltaMode === 1 ? e.deltaX * 16 : e.deltaX;
      if (Math.abs(sum) < 90) return;
      fired = true;
      skip(sum > 0 ? 20 : -20);
    }, { capture: true, passive: false });
  })();

  // In the Watch Party window the party's own buttons are right there, except in fullscreen.
  const wanted = () => bound && !!ui && (!!document.fullscreenElement || !inWindow);

  function build() {
    host = document.createElement('div');
    host.setAttribute('style', 'all:initial;position:fixed;z-index:2147483647;left:0;top:0;');
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: system-ui, "Segoe UI", sans-serif; }
      .wrap { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
      .bar { display: flex; align-items: center; gap: 4px; padding: 5px; border-radius: 99px; background: rgba(12,13,16,.82); border: 1px solid rgba(255,255,255,.14); box-shadow: 0 8px 24px rgba(0,0,0,.45); backdrop-filter: blur(8px); }
      .grip { width: 16px; height: 34px; cursor: grab; display: grid; place-items: center; color: rgba(255,255,255,.45); font-size: 14px; user-select: none; touch-action: none; }
      .grip:active { cursor: grabbing; }
      button { width: 36px; height: 36px; border-radius: 50%; border: 0; background: rgba(255,255,255,.1); color: #fff; cursor: pointer; display: grid; place-items: center; padding: 0; position: relative; }
      button:hover { background: rgba(255,255,255,.2); }
      button.on { background: var(--brand); color: var(--brand-ink); }
      .wrap { --brand: ${BRAND[0]}; --brand-ink: ${BRAND[1]}; }
      /* like the player's own controls: the bar fades away when the mouse rests, the cameras stay and slide into its place */
      .bar, .chat { transition: opacity .3s, max-height .3s, margin .3s, padding .3s, border-width .3s; max-height: 60px; overflow: hidden; }
      .chat { max-height: 360px; }
      .wrap.idle .bar, .wrap.idle .chat { opacity: 0; max-height: 0; padding-top: 0; padding-bottom: 0; border-width: 0; margin: 0 0 -6px; pointer-events: none; }
      .wrap.idle.up .bar, .wrap.idle.up .chat { margin: -6px 0 0; }
      button.off { background: rgba(239,93,93,.25); }
      button:disabled { opacity: .4; cursor: not-allowed; }
      svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
      .dot { position: absolute; top: 3px; right: 3px; width: 9px; height: 9px; border-radius: 50%; background: #ef5d5d; display: none; }
      .dot.show { display: block; }
      .faces { display: flex; gap: 6px; flex-wrap: wrap; max-width: 560px; }
      .face { position: relative; width: 150px; aspect-ratio: 16 / 10; border-radius: 10px; overflow: hidden; background: #16181d; border: 1px solid rgba(255,255,255,.14); box-shadow: 0 8px 24px rgba(0,0,0,.45); }
      .face video { width: 100%; height: 100%; object-fit: cover; display: block; }
      .face.self video { transform: scaleX(-1); }
      .face span { position: absolute; left: 6px; bottom: 5px; font-size: 11px; font-weight: 600; color: #fff; background: rgba(0,0,0,.55); padding: 1px 7px; border-radius: 99px; }
      .chat { width: 320px; max-height: 340px; display: flex; flex-direction: column; border-radius: 14px; background: rgba(12,13,16,.9); border: 1px solid rgba(255,255,255,.14); box-shadow: 0 8px 24px rgba(0,0,0,.45); overflow: hidden; }
      .list { flex: 1; overflow-y: auto; padding: 8px 10px; display: flex; flex-direction: column; gap: 5px; color: #eceef2; font-size: 13.5px; line-height: 1.35; max-height: 260px; }
      .list b { color: #f5b544; margin-right: 6px; }
      .list .sys { color: #8a8f99; font-size: 12px; text-align: center; }
      form { display: flex; gap: 6px; padding: 8px; border-top: 1px solid rgba(255,255,255,.1); }
      input { flex: 1; min-width: 0; height: 34px; border-radius: 9px; border: 1px solid rgba(255,255,255,.18); background: #1b1d23; color: #fff; padding: 0 10px; font-size: 13.5px; outline: none; }
      form button { border-radius: 9px; width: auto; padding: 0 12px; height: 34px; background: var(--brand); color: var(--brand-ink); font-weight: 700; font-size: 13px; }
      .list b { color: var(--brand); }
      [hidden] { display: none !important; }
    </style>
    <div class="wrap">
      <div class="bar">
        <div class="grip" title="Drag to move">⋮⋮</div>
        <button data-a="cam" title="Camera"><svg viewBox="0 0 24 24"><path d="M15 10l5-3v10l-5-3z"/><rect x="3" y="6" width="12" height="12" rx="2"/></svg></button>
        <button data-a="mic" title="Microphone"><svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></button>
        <button data-a="chat" title="Chat"><svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg><i class="dot"></i></button>
        <button data-a="faces" title="Show or hide everyone's cameras"><svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 14.5A5 5 0 0 1 21 19"/></svg></button>
      </div>
      <div class="faces" id="faces"></div>
      <div class="chat" id="chat" hidden><div class="list" id="list"></div><form id="form" autocomplete="off"><input id="input" maxlength="500" placeholder="Say something…"><button type="submit">Send</button></form></div>
    </div>`;
    // typing here must not reach the video player's keyboard shortcuts (space would pause it)
    for (const ev of ['keydown', 'keyup', 'keypress']) root.addEventListener(ev, e => e.stopPropagation());
    root.addEventListener('click', e => {
      const b = e.target.closest('button[data-a]');
      if (!b) return;
      const a = b.dataset.a;
      if (a === 'cam' || a === 'mic') act({ op: a });
      else if (a === 'chat') { chatOpen = !chatOpen; seenChat = ui ? ui.chat.length : 0; render(); if (chatOpen) setTimeout(() => root.getElementById('input').focus(), 30); }
      else if (a === 'faces') { facesOpen = !facesOpen; if (facesOpen) send({ type: 'want-cams' }); render(); }
    });
    root.getElementById('form').addEventListener('submit', e => {
      e.preventDefault();
      const i = root.getElementById('input');
      const text = i.value.trim();
      if (text) act({ op: 'chat', text });
      i.value = '';
    });
    // drag anywhere by the grip; remembered for next time (as a share of the screen)
    const grip = root.querySelector('.grip');
    grip.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      grip.setPointerCapture(e.pointerId);
      const r = root.querySelector('.bar').getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = ev => place(ev.clientX - dx, ev.clientY - dy);
      const up = () => { grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); save(); };
      grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up);
    });
    for (const ev of ['pointerdown', 'mousedown', 'click', 'dblclick']) host.addEventListener(ev, e => e.stopPropagation()); // don't pause the video
    host.addEventListener('pointerenter', () => { hovering = true; wake(); });
    host.addEventListener('pointerleave', () => { hovering = false; wake(); });
    setTimeout(wake, 0);
  }
  // (x, y) is where the button bar's top-left corner goes
  const BAR_H = 46;
  let pos = { x: 24, y: 200 };
  function place(x, y) {
    x = Math.max(4, Math.min(innerWidth - 200, x));
    y = Math.max(4, Math.min(innerHeight - BAR_H - 4, y));
    pos = { x, y };
    host.style.left = `${x}px`;
    // Near the bottom, chat and faces open upwards (so they stay on screen), and the whole thing hangs
    // from the bar's bottom edge, so when the bar fades away the cameras slide down into its place.
    // Near the top it's the other way round: the cameras slide up into the bar's place.
    const up = y > innerHeight * 0.5;
    if (up) { host.style.top = 'auto'; host.style.bottom = `${innerHeight - y - BAR_H}px`; }
    else { host.style.bottom = 'auto'; host.style.top = `${y}px`; }
    const wrap = root && root.querySelector('.wrap');
    if (wrap) { wrap.style.flexDirection = up ? 'column-reverse' : 'column'; wrap.classList.toggle('up', up); }
  }
  function save() { try { localStorage.setItem(POS_KEY, JSON.stringify({ x: pos.x / innerWidth, y: pos.y / innerHeight })); } catch { /* ignore */ } }
  function restore() {
    let p = null;
    try { p = JSON.parse(localStorage.getItem(POS_KEY) || 'null'); } catch { /* ignore */ }
    if (p) place(p.x * innerWidth, p.y * innerHeight); else place(24, Math.round(innerHeight * 0.3));
  }

  let seenChat = 0;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function render() {
    if (!wanted()) { if (host) host.remove(); return; }
    if (!host) { build(); }
    const parent = document.fullscreenElement || document.documentElement;
    if (host.parentNode !== parent) { parent.appendChild(host); restore(); for (const v of root.querySelectorAll('video')) v.play().catch(() => {}); }
    const cam = root.querySelector('[data-a="cam"]'), mic = root.querySelector('[data-a="mic"]');
    cam.className = ui.myCam ? 'on' : ''; cam.disabled = !ui.canCam; cam.title = ui.myCam ? 'Turn your camera off' : 'Turn your camera on';
    mic.className = ui.myMic ? 'on' : ''; mic.disabled = !ui.canCam; mic.title = ui.myMic ? 'Mute your microphone' : 'Turn your microphone on';
    root.querySelector('[data-a="chat"]').className = chatOpen ? 'on' : '';
    root.querySelector('[data-a="faces"]').className = facesOpen ? 'on' : '';
    root.getElementById('chat').hidden = !chatOpen;
    if (chatOpen) seenChat = ui.chat.length;
    root.querySelector('.dot').classList.toggle('show', !chatOpen && ui.chat.length > seenChat && ui.chat.slice(seenChat).some(c => !c.system && !c.me));
    const list = root.getElementById('list');
    const html = ui.chat.slice(-40).map(c => c.system ? `<div class="sys">${esc(c.text)}</div>` : `<div><b>${esc(c.name)}</b>${esc(c.text)}</div>`).join('');
    if (list.dataset.h !== html) { list.dataset.h = html; list.innerHTML = html; list.scrollTop = list.scrollHeight; }
    root.getElementById('input').disabled = !ui.canChat;
    renderFaces();
  }
  function renderFaces() {
    const box = root.getElementById('faces');
    const want = facesOpen ? (ui.cams || []) : [];
    box.hidden = !want.length;
    const ids = new Set(want.map(c => c.sid));
    for (const el of [...box.children]) if (!ids.has(el.dataset.sid)) el.remove();
    for (const c of want) {
      let el = [...box.children].find(x => x.dataset.sid === c.sid);
      if (!el) { el = document.createElement('div'); el.className = 'face' + (c.self ? ' self' : ''); el.dataset.sid = c.sid; el.innerHTML = '<video autoplay playsinline muted></video><span></span>'; box.appendChild(el); }
      el.querySelector('span').textContent = c.name;
      const v = el.querySelector('video'), s = streams.get(c.sid);
      if (s && v.srcObject !== s) { v.srcObject = s; v.play().catch(() => {}); }
    }
  }
  function closeRtc() { if (pc) try { pc.close(); } catch {} pc = null; streams.clear(); pendingIce = []; }
  async function onRtc(d) {
    try {
      if (d.none) { closeRtc(); if (host) renderFaces(); return; }
      if (d.sdp && d.sdp.type === 'offer') {
        closeRtc();
        const conn = new RTCPeerConnection();
        pc = conn;
        conn.ontrack = e => { const st = e.streams && e.streams[0]; if (st) { streams.set(st.id, st); if (host && ui) renderFaces(); } };
        conn.onicecandidate = e => { if (e.candidate && pc === conn) send({ type: 'dock-rtc', data: { ice: e.candidate.toJSON() } }); };
        await conn.setRemoteDescription(d.sdp);
        await conn.setLocalDescription(await conn.createAnswer());
        send({ type: 'dock-rtc', data: { sdp: { type: conn.localDescription.type, sdp: conn.localDescription.sdp } } });
        for (const c of pendingIce.splice(0)) await conn.addIceCandidate(c).catch(() => {});
      } else if (d.ice) {
        if (!pc || !pc.remoteDescription) pendingIce.push(d.ice); else await pc.addIceCandidate(d.ice).catch(() => {});
      }
    } catch { /* cameras just don't show */ }
  }
  // hide the buttons when the mouse rests (never while you're typing or pointing at them)
  let idleTimer = null, hovering = false;
  function wake() {
    const wrap = root && root.querySelector('.wrap');
    if (!wrap) return;
    wrap.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const typing = root.activeElement && root.activeElement.id === 'input';
      if (hovering || typing) { wake(); return; }
      wrap.classList.add('idle');
    }, 3000);
  }
  for (const ev of ['mousemove', 'pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart']) document.addEventListener(ev, wake, { capture: true, passive: true });
  document.addEventListener('fullscreenchange', () => { render(); if (host && host.isConnected) restore(); wake(); });
  addEventListener('resize', () => { if (host && host.isConnected) restore(); });
  connect();
})();
