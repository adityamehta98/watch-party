// Runs inside Netflix's own page. Netflix's player must be moved with its own controls
// (changing the video's time directly makes Netflix show an error), so we call its player API.
(() => {
  if (window.__wpNetflix) return;
  window.__wpNetflix = true;
  function player() {
    try {
      const vp = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      const ids = vp.getAllPlayerSessionIds();
      return ids.length ? vp.getVideoPlayerBySessionId(ids[ids.length - 1]) : null;
    } catch { return null; }
  }
  window.addEventListener('message', e => {
    if (e.source !== window || !e.data || e.data.source !== 'wp-cs') return;
    const { op, t } = e.data;
    const p = player();
    const v = document.querySelector('video');
    const result = (ok, error = '') => window.postMessage({ source: 'wp-netflix', op, ok, error }, location.origin);
    try {
      if (op === 'seek') {
        if (p && Number.isFinite(t) && t >= 0) { p.seek(Math.round(t * 1000)); result(true); }
        else result(false, 'unavailable');
      }
      else if (op === 'play') {
        if (!p && !v) { result(false, 'unavailable'); return; }
        Promise.resolve(p ? p.play() : v.play()).then(() => result(true), error => result(false, error?.name || 'blocked'));
      }
      else if (op === 'pause') { if (p) p.pause(); else if (v) v.pause(); }
      // through Netflix's own player, so its volume slider shows the same level
      else if (op === 'volume') { if (p && p.setVolume) p.setVolume(Math.max(0, Math.min(1, t))); else if (v) v.volume = Math.max(0, Math.min(1, t)); }
      else if (op === 'mute') { if (p && p.setMuted) p.setMuted(!!t); else if (v) v.muted = !!t; }
    } catch (error) { if (op === 'play' || op === 'seek') result(false, error?.name || 'unavailable'); }
  });
})();
