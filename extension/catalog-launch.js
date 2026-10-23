// Complete a verified catalog pick, then restore and persist the actual player position.
(() => {
  if (window.__wpCatalogLaunch) return;
  window.__wpCatalogLaunch = true;
  const service = wpServiceOf(location.hostname);
  const topService = window === window.top || (location.ancestorOrigins?.length === 1 && /^chrome-extension:/.test(location.ancestorOrigins[0]));
  if (!service || service === 'youtube' || !topService) return;
  const storageKey = 'wp.catalogLaunch';
  const normalize = WPPlayback.normalize;
  const labelKey = text => normalize(text).replace(/^(?:resume|continue watching|watch|play)\s+/, '');
  const labels = el => [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('alt'),
    ...[...el.querySelectorAll('img[alt], [aria-label], .fallback-text')].map(child => child.getAttribute('alt') || child.getAttribute('aria-label') || child.textContent),
    el.textContent];
  const matches = (el, title) => labels(el).some(label => labelKey(label) === normalize(title));
  function visible(el) {
    const r = el.getBoundingClientRect(), css = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && css.display !== 'none' && css.visibility !== 'hidden';
  }
  function exactTitle(title) {
    const targets = new Map();
    for (const el of document.querySelectorAll('a[href], [role="link"], [role="button"][aria-label], .title-card .slider-refocus')) {
      const card = el.closest('.title-card-container, [data-video-id], [data-videoid]') || el;
      if (!visible(el) || (!matches(el, title) && !matches(card, title))) continue;
      if (/trailer|teaser|rent|buy|purchase|subscribe|trial|restart/i.test(el.getAttribute('aria-label') || '')) continue;
      const year = /\b(?:19|20)\d{2}\b/.exec(card.getAttribute('data-year') || card.textContent || '')?.[0];
      if (intent.meta?.year && year && String(intent.meta.year) !== year) continue;
      const mediaType = card.getAttribute('data-media-type');
      if (intent.meta?.type && mediaType && intent.meta.type !== mediaType) continue;
      const href = el.getAttribute('href');
      let key = card;
      if (href) {
        let url;
        try { url = new URL(href, location.href); } catch { continue; }
        const netflixId = service === 'netflix' && (/\/(?:watch|title)\/(\d+)/.exec(url.pathname)?.[1] || url.searchParams.get('jbv'));
        if (url.protocol !== 'https:' || wpServiceOf(url.hostname) !== service || /\/(?:login|signin|subscribe)(?:\/|$)/i.test(url.pathname)) continue;
        // Netflix opens details by adding ?jbv=<title ID> to the current search URL.
        if (/\/search(?:\/|$)/i.test(url.pathname) && !/^\d+$/.test(netflixId || '')) continue;
        if (intent.meta?.year && !year && WPPlayback.asset(url.href, service)) continue;
        key = netflixId || url.origin + url.pathname;
      }
      if (intent.meta?.year && !year && /^(?:resume|continue watching|play)\b/i.test(el.getAttribute('aria-label') || el.textContent.trim())) continue;
      const rank = node => /^(?:resume|continue watching)\b/i.test(node.getAttribute('aria-label') || node.textContent.trim()) ? 2 : /^play\b/i.test(node.getAttribute('aria-label') || node.textContent.trim()) ? 1 : 0;
      if (!targets.has(key) || rank(el) > rank(targets.get(key))) targets.set(key, el);
    }
    return targets.size === 1 ? [...targets.values()][0] : null;
  }
  function resumeButton(scope) {
    const controls = [...scope.querySelectorAll('a[href], button, [role="button"]')].filter(el => {
      if (!visible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
      const text = el.getAttribute('aria-label') || el.textContent || '';
      if (/trailer|teaser|rent|buy|purchase|subscribe|trial|restart|watch again/i.test(text)) return false;
      const label = normalize(text);
      if (!/^(?:resume|continue watching|play|watch now)(?:\s|$)/.test(label)) return false;
      const href = el.getAttribute('href');
      if (href) { try { if (wpServiceOf(new URL(href, location.href).hostname) !== service) return false; } catch { return false; } }
      return true;
    });
    return controls.find(el => /^(?:resume|continue watching)/i.test(el.getAttribute('aria-label') || el.textContent.trim())) || controls[0] || null;
  }
  function titleDetails(title) {
    const scopes = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], .previewModal--container, .previewModal--wrapper, [data-uia="previewModal"]')];
    if (!scopes.length && !/\/search(?:\/|$)/i.test(location.pathname)) scopes.push(document);
    return scopes.find(scope => [...scope.querySelectorAll('h1, h2, [role="heading"], img[alt], [data-uia="video-title"], [data-testid="title"]')]
      .some(el => matches(el, title))) || null;
  }
  function signingIn() {
    return /\/(?:login|signin|sign-in|profiles|ProfilesGate|auth)(?:\/|$)/i.test(location.pathname) ||
      [...document.querySelectorAll('input[type="password"], input[autocomplete="one-time-code"], [data-uia="pin-input"], [data-uia="pin-number-input"], .profiles-gate-container, .list-profiles')].some(visible);
  }
  let intent = null, phase = '', started = 0, nextAction = 0, busy = false, cancelled = '';
  let history = null, saved = null, selectedId = '', seekAt = 0, playAt = 0, lastSaved = 0, readyAt = 0;
  let restored = false, unavailable = false, notified = false, verifiedAsset = '', nativeResume = false, wasSigningIn = false;
  let initialized = false, trackAfter = 0;
  const detailPlayer = service === 'prime' || service === 'appletv';
  function remember(next) {
    phase = next;
    try { sessionStorage.setItem(storageKey, JSON.stringify({ id: intent.id, phase, selectedId, restored, verifiedAsset, nativeResume, at: Date.now() })); } catch { /* private browsing */ }
  }
  function restore(id) {
    try {
      const state = JSON.parse(sessionStorage.getItem(storageKey));
      if (state?.id !== id || Date.now() - state.at > 86400000) return '';
      selectedId = state.selectedId || ''; restored = !!state.restored; verifiedAsset = state.verifiedAsset || '';
      nativeResume = !!state.nativeResume;
      return state.phase;
    } catch { return ''; }
  }
  const report = error => { if (intent && !notified) { notified = true; chrome.runtime.sendMessage({ wp: 'catalog-launch-unmatched', id: intent.id, error }).catch(() => {}); } };
  window.addEventListener('message', e => {
    if (e.source !== window || e.data?.source !== 'wp-netflix' || e.data.ok !== false || !intent) return;
    if (e.data.op === 'play') report('Playback needs a click. Press Play inside Netflix to continue.');
    if (e.data.op === 'seek' && seekAt) {
      remember('unmatched'); window.__wpCatalogRestoring = false;
      report('Netflix could not restore the saved timestamp. Use its playback controls to resume.');
    }
  });
  function player() {
    const videos = [...document.querySelectorAll('video')];
    const walk = root => { for (const el of root.querySelectorAll('*')) if (el.shadowRoot) { videos.push(...el.shadowRoot.querySelectorAll('video')); walk(el.shadowRoot); } };
    if (!videos.length) walk(document);
    return videos.filter(v => visible(v) && v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 60)
      .sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0];
  }
  function command(v, op, t) {
    if (service === 'netflix') window.postMessage({ source: 'wp-cs', op, t }, location.origin);
    else if (op === 'seek') v.currentTime = t;
    else {
      try { Promise.resolve(v.play()).catch(() => report('Playback needs a click. Press Play inside the streaming service to continue.')); }
      catch { report('Playback needs a click. Press Play inside the streaming service to continue.'); }
    }
  }
  function titleMatchesPlayer() {
    const titles = [...document.querySelectorAll('[data-uia="video-title"], .atvwebplayersdk-title-text, .PlayerMetadata__titleText, [data-testid="player-ux-asset-title"], .title-field, [data-t="player-title"], .show-title-link')];
    return titles.some(el => normalize(el.textContent.split(' · ')[0].replace(/\s*S(?:eason\s*)?\d+\s*[:·,\- ]*E(?:pisode\s*)?\d+\b.*$/i, '')) === normalize(intent.title));
  }
  function saveProgress(v, force = false) {
    const identity = WPPlayback.asset(location.href, service);
    if (!history || !identity || !restored || v.seeking || v.readyState < 2 || window.__wpPlaybackAd || unavailable || Date.now() < trackAfter) return;
    if (saved && identity.assetId !== saved.assetId && !titleMatchesPlayer()) return;
    if (!titleMatchesPlayer() && saved?.assetId !== identity.assetId && verifiedAsset !== identity.assetId) return;
    if (!force && Date.now() - lastSaved < 5000) return;
    lastSaved = Date.now();
    const metadata = [...document.querySelectorAll('[data-uia="video-title"], .atvwebplayersdk-subtitle-text, .PlayerMetadata__subTitle, [data-testid="player-ux-asset-subtitle"], .subtitle-field')].map(e => e.textContent).join(' ');
    const ep = WPPlayback.episode(metadata);
    const old = history.entries[identity.assetId];
    const entry = { ...identity, showId: selectedId || saved?.showId || identity.assetId, title: intent.title,
      catalog: intent.meta || {}, season: ep.season ?? old?.season ?? null, episode: ep.episode ?? old?.episode ?? null,
      position: v.currentTime, duration: v.duration, lastWatched: Date.now() };
    history.record(entry).catch(() => { unavailable = true; report('Progress could not be saved. Check extension storage before closing this tab.'); });
  }
  for (const event of ['pause', 'seeked', 'ended', 'pagehide']) document.addEventListener(event, () => { const v = player(); if (v) saveProgress(v, true); }, true);
  window.addEventListener('pagehide', () => { const v = player(); if (v) saveProgress(v, true); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { const v = player(); if (v) saveProgress(v, true); } });
  // A manual title choice takes priority over the pending automatic selection.
  document.addEventListener('pointerdown', e => {
    if (!e.isTrusted || !intent || signingIn()) return;
    // Play, pause, timeline and login interactions must not cancel history or a blocked autoplay recovery.
    const target = e.target?.closest?.('.title-card, .title-card-container, a[href*="/title/"], a[href*="jbv="]');
    if (target && phase !== 'done') { cancelled = intent.id; remember('cancelled'); window.__wpCatalogRestoring = false; }
  }, true);
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const request = await chrome.runtime.sendMessage({ wp: 'catalog-launch' });
      if (!request?.id || !request.title || request.service !== service) {
        window.__wpCatalogRestoring = false;
        if (request?.inactive) intent = null;
        else if (intent && restored) { const v = player(); if (v) saveProgress(v); }
        return;
      }
      if (intent?.id !== request.id) {
        intent = request; selectedId = ''; restored = false; verifiedAsset = ''; nativeResume = false; phase = restore(request.id); started = 0; nextAction = 0;
        if (!initialized && phase === 'done' && request.launch !== false) { phase = 'playback'; restored = false; }
        initialized = true; trackAfter = request.launch === false ? Date.now() + 5000 : 0;
        seekAt = playAt = lastSaved = readyAt = 0; unavailable = false; notified = false;
        window.__wpCatalogRestoring = request.launch !== false && !restored;
        history = new WPPlayback.History(chrome.storage.local, WPPlayback.key(service, request.title, request.meta), service);
        try { saved = await history.load(); }
        catch { unavailable = true; window.__wpCatalogRestoring = false; remember('unmatched'); report('Saved progress could not be read. Open the title manually to avoid resetting your progress.'); return; }
      }
      if (unavailable) return;
      if (signingIn()) { wasSigningIn = true; started = 0; readyAt = 0; return; }
      const now = Date.now();
      if (wasSigningIn) {
        wasSigningIn = false;
        if (request.launch !== false && phase !== 'done' && !WPPlayback.asset(location.href, service) && !titleDetails(intent.title)) {
          const destination = saved?.url || intent.url;
          remember(saved ? detailPlayer ? 'details' : 'playback' : '');
          if (location.href !== new URL(destination).href) { location.assign(destination); return; }
        }
      }
      const identity = WPPlayback.asset(location.href, service), v = identity && player();
      if (cancelled === intent.id || phase === 'cancelled' || phase === 'unmatched') {
        window.__wpCatalogRestoring = false;
        if (v && titleMatchesPlayer()) { restored = true; verifiedAsset = identity.assetId; saveProgress(v); }
        return;
      }
      if (phase === 'done' || request.launch === false) { restored = true; window.__wpCatalogRestoring = false; if (v) saveProgress(v); return; }
      if (v && (phase === 'playback' || saved?.assetId === identity.assetId) && !window.__wpPlaybackAd) {
        window.__wpCatalogRestoring = true;
        if (saved && saved.assetId !== identity.assetId) {
          remember('unmatched'); window.__wpCatalogRestoring = false;
          report('The service opened a different episode. Select the saved episode to resume safely.'); return;
        }
        if (!readyAt) readyAt = now;
        if (v.readyState < 2 || v.seeking || now - readyAt < 1200) {
          if (now - readyAt > 30000) { remember('unmatched'); window.__wpCatalogRestoring = false; report('The player is unavailable or still loading. Use the service controls to continue.'); }
          return;
        }
        const position = saved ? Math.min(saved.position, Math.max(0, v.duration - 0.25)) : nativeResume ? v.currentTime : 0;
        if (!restored && Math.abs(v.currentTime - position) > 2) {
          if (!seekAt) { seekAt = now; command(v, 'seek', position); return; }
          if (now - seekAt < 12000) return;
          remember('unmatched'); window.__wpCatalogRestoring = false;
          report('The service did not restore the saved timestamp. Use its playback controls to resume.'); return;
        }
        restored = true; verifiedAsset = identity.assetId;
        if (v.paused) {
          if (!playAt) { playAt = now; command(v, 'play'); }
          else if (now - playAt > 8000) report('Playback needs a click. Press Play inside the streaming service to continue.');
          return;
        }
        remember('done'); window.__wpCatalogRestoring = false; saveProgress(v, true); return;
      }
      if (!started) started = now;
      if (now - started > 60000) {
        remember('unmatched');
        window.__wpCatalogRestoring = false;
        chrome.runtime.sendMessage({ wp: 'catalog-launch-unmatched', id: intent.id }).catch(() => {});
        return;
      }
      if (now < nextAction) return;
      if (phase === 'details') {
        const scope = titleDetails(intent.title), play = scope && resumeButton(scope);
        const year = scope && ([...scope.querySelectorAll('span, [data-year]')]
          .map(el => el.getAttribute('data-year') || el.textContent.trim()).find(text => /^(?:19|20)\d{2}$/.test(text))
          || /\b(?:19|20)\d{2}\b/.exec(scope.textContent)?.[0]);
        if (intent.meta?.year && String(intent.meta.year) !== year) return;
        if (play) { nativeResume = /^(?:resume|continue watching)\b/i.test(play.getAttribute('aria-label') || play.textContent.trim()); remember('playback'); playAt = 0; play.click(); }
        return;
      }
      if (phase === 'playback') return;
      // Only automate the search requested by Watch Party; don't hijack the viewer's own search.
      const wanted = new URL(intent.url), here = new URL(location.href);
      const query = ['q', 'phrase', 'query', 'term'].find(key => wanted.searchParams.has(key));
      if (query && normalize(here.searchParams.get(query)) !== normalize(wanted.searchParams.get(query))) {
        // Login can drop the search redirect. Return only to the exact search this party requested.
        if (!/\/search(?:\/|$)/i.test(here.pathname)) { nextAction = now + 10000; location.assign(intent.url); }
        return;
      }
      if (saved && WPPlayback.asset(saved.url, service)) { selectedId = saved.showId; remember(detailPlayer ? 'details' : 'playback'); location.assign(saved.url); return; }
      const target = exactTitle(intent.title);
      if (!target) return;
      const targetUrl = target.getAttribute('href');
      selectedId = targetUrl && /(?:\/(?:title|watch)\/|[?&]jbv=)(\d+)/.exec(targetUrl)?.[1] || target.closest('[data-video-id]')?.getAttribute('data-video-id') || (targetUrl ? new URL(targetUrl, location.href).pathname : '');
      const direct = !detailPlayer && WPPlayback.asset(targetUrl && new URL(targetUrl, location.href).href, service);
      const nativePlay = /^(?:resume|continue watching|play)\b/i.test(target.getAttribute('aria-label') || target.textContent.trim());
      nativeResume = /^(?:resume|continue watching)\b/i.test(target.getAttribute('aria-label') || target.textContent.trim());
      remember(direct || nativePlay ? 'playback' : 'details');
      nextAction = now + 1000;
      target.click();
    } catch { /* worker waking up: retry without changing the selected service */ }
    finally { busy = false; }
  }
  setInterval(tick, 700);
  tick();
})();
