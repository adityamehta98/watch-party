// Ad cleaner for custom sites in the Watch Party window (never on Netflix & co, never anywhere else).
// Leaves the video and the site's own buttons, and removes what's piled on top of them:
//  - invisible "click anywhere" layers over the video and over the whole page
//  - links and scripts that open ad tabs or yank the whole window to an ad
//  - leftover ad boxes
(() => {
  if (window.__wpClean) return;
  window.__wpClean = true;
  const AD = self.WP_AD_DOMAINS || [];
  const isAd = h => !!h && AD.some(d => h === d || h.endsWith('.' + d));
  const sameSite = (a, b) => a === b || a.endsWith('.' + b) || b.endsWith('.' + a);
  const depth = (location.ancestorOrigins && location.ancestorOrigins.length) || 1; // 1 = the site's own page

  // ---- ad boxes
  const style = document.createElement('style');
  style.textContent = 'ins.adsbygoogle,[id^="google_ads_"],[id^="div-gpt-ad"],iframe[id^="google_ads_iframe"],iframe[src*="doubleclick.net"],iframe[src*="googlesyndication"]{display:none!important}';
  (document.head || document.documentElement).appendChild(style);

  // ---- links: no new tabs to other sites, and nothing may take over the Watch Party window
  addEventListener('click', e => {
    const a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    let u; try { u = new URL(a.href, location.href); } catch { return; }
    if (!/^https?:$/.test(u.protocol)) return;
    const t = (a.getAttribute('target') || '').toLowerCase();
    if (isAd(u.hostname)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (t === '_blank') {
      // another site in a new tab: an ad. This site in a new tab: open it here instead.
      if (!sameSite(u.hostname, location.hostname)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
      a.setAttribute('target', depth === 1 ? '_self' : '_parent');
    } else if (t === '_top' || t === '_parent') {
      // "the whole window" would be the Watch Party: keep it inside the site's own box
      if (depth === 1) a.setAttribute('target', '_self');
      else if (t === '_top') a.setAttribute('target', '_parent');
    }
  }, true);

  // ---- layers on top of the video / page
  const hidden = new WeakSet();
  function hide(el) {
    if (!el || hidden.has(el) || el === document.body || el === document.documentElement) return;
    hidden.add(el);
    el.style.setProperty('display', 'none', 'important');
    el.style.setProperty('pointer-events', 'none', 'important');
  }
  const area = el => { const r = el.getBoundingClientRect(); return Math.max(0, r.width) * Math.max(0, r.height); };
  // the player: the biggest video; or else (players often sit in a frame) the biggest frame that isn't an ad
  function player() {
    let best = null, bestA = 0;
    for (const v of document.querySelectorAll('video')) { const a = area(v); if (a > bestA && a >= 200 * 112) { best = v; bestA = a; } }
    if (best) return best;
    for (const f of document.querySelectorAll('iframe')) {
      let h = ''; try { h = new URL(f.src, location.href).hostname; } catch { /* no address */ }
      const a = area(f);
      if (!isAd(h) && a > bestA && a >= Math.max(400 * 225, innerWidth * innerHeight * 0.15)) { best = f; bestA = a; }
    }
    return best;
  }
  // the player's own box: its ancestors that are about the same size (its controls live in there)
  function box(p) {
    let c = p;
    while (c.parentElement && c.parentElement !== document.body && c.parentElement !== document.documentElement) {
      if (area(c.parentElement) > area(c) * 1.6 + 1) break;
      c = c.parentElement;
    }
    return c;
  }
  const positioned = el => { const p = getComputedStyle(el).position; return p === 'fixed' || p === 'absolute'; };
  // the outermost positioned element around `hit` that doesn't hold the player: that's the layer
  function layerOf(hit, keep) {
    let layer = null;
    for (let el = hit; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      if (el.contains(keep)) break;
      if (positioned(el)) layer = el;
    }
    return layer;
  }
  const inside = (el, keep) => !!el && (keep.contains(el) || el.contains(keep));
  function sweep() {
    const p = player();
    if (p) {
      const keep = box(p);
      const r = p.getBoundingClientRect();
      for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.3], [0.75, 0.3], [0.25, 0.7], [0.75, 0.7]]) {
        const x = r.left + r.width * fx, y = r.top + r.height * fy;
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
        for (let i = 0; i < 6; i++) {
          const hit = document.elementFromPoint(x, y);
          if (!hit || inside(hit, keep)) break;
          const layer = layerOf(hit, keep);
          if (!layer || hidden.has(layer)) break;
          hide(layer);
        }
      }
    }
    // page-wide layers: something positioned covering most of the window, with no player in it
    const keep = p ? box(p) : null;
    for (const [fx, fy] of [[0.5, 0.5], [0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]]) {
      const hit = document.elementFromPoint(innerWidth * fx, innerHeight * fy);
      if (!hit || (keep && inside(hit, keep))) continue;
      for (let el = hit; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
        if (keep && el.contains(keep)) break;
        const cs = getComputedStyle(el);
        const z = parseInt(cs.zIndex, 10) || 0;
        // an ad layer: pinned over the page (or stacked very high), big, and with next to no content of its own
        if ((cs.position === 'fixed' || (cs.position === 'absolute' && z > 1000)) && area(el) > innerWidth * innerHeight * 0.4
          && !el.querySelector('video, input, select, textarea') && (el.innerText || '').trim().length < 40) { hide(el); break; }
      }
    }
    // frames from ad networks
    for (const f of document.querySelectorAll('iframe')) { try { if (isAd(new URL(f.src, location.href).hostname)) hide(f); } catch { /* no address */ } }
  }
  // A click that lands on something over the video that isn't the player: swallow it, remove the layer.
  // (Click again and it reaches the player.)
  addEventListener('pointerdown', e => {
    const p = player();
    if (!p) return;
    const r = p.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
    const keep = box(p);
    if (inside(e.target, keep)) return;
    const layer = layerOf(e.target, keep);
    if (!layer) return;
    e.preventDefault(); e.stopImmediatePropagation();
    hide(layer);
    const swallow = ev => { ev.preventDefault(); ev.stopImmediatePropagation(); };
    addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => removeEventListener('click', swallow, true), 600);
  }, true);
  let queued = false;
  const soon = () => { if (!queued) { queued = true; setTimeout(() => { queued = false; try { sweep(); } catch { /* page busy */ } }, 400); } };
  try { new MutationObserver(soon).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] }); } catch { /* no document */ }
  setInterval(soon, 1000);
  soon();
})();
