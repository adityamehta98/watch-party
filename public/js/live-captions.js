// Live captions, "catch me up" and highlights for the player. Folds into the existing CC popover
// (so there's just one CC button); listens to its own room messages and keeps its own text track.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clock = t => { t = Math.max(0, Math.floor(Number(t) || 0)); const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`; };
const PREF = 'wp.liveCaptions';
const pref = () => { try { return localStorage.getItem(PREF) !== 'off'; } catch { return true; } };
const savePref = on => { try { localStorage.setItem(PREF, on ? 'on' : 'off'); } catch { /* private mode */ } };

const STATUS_TEXT = {
  unavailable: 'Live captions are unavailable on this PC. They need ffmpeg and a transcription token (Hugging Face or Groq, see README).',
  unsupported: 'Live captions work for library movies, anime and Movies & TV. Streaming services play inside each viewer\'s own browser, so their audio is not available here.',
  unauthorized: 'The transcription token was refused. Live captions turned off.',
  'rate-limited': 'The transcription service asked to slow down. Captions continue shortly.',
  error: 'Some audio could not be transcribed. Retrying.',
  credits: 'The transcription account has no inference credits. Add credits or configure a Groq token.',
};
const RECAP_TEXT = {
  unavailable: 'Nothing to summarize yet. "Catch me up" works once live captions have been on for a while.',
  busy: 'Please wait a few seconds before asking again.',
  stale: 'The movie changed. Try the summary again.',
  failed: 'The summary could not be made right now. Try again in a moment.',
};
const HIGHLIGHT_TEXT = {
  unavailable: 'Highlights need ffmpeg with an H.264 encoder on the host PC.',
  unsupported: 'Highlights work for library movies, anime and Movies & TV.',
  'too-short': 'Watch a little more first, then try again.',
  'none-found': 'No stand-out moments were found yet.',
  failed: 'Highlights could not be made for this title.',
};

const STYLE = `
.live-dot { position: relative; }
.live-dot.on::after { content: ""; position: absolute; top: 9px; right: 8px; width: 7px; height: 7px; border-radius: 50%; background: #ff4d4f; box-shadow: 0 0 0 2px rgba(0,0,0,.5); }
#ccPop .live-clip { display: flex; align-items: center; gap: 6px; padding: 2px 4px; }
#ccPop .live-clip a { flex: 1; padding: 7px 6px; border-radius: 8px; color: inherit; text-decoration: none; }
#ccPop .live-clip a:hover { background: rgba(255,255,255,.08); }
#ccPop .live-clip button { width: auto; padding: 6px 10px; }
.live-recap { position: absolute; top: 14px; left: 50%; transform: translateX(-50%); z-index: 12; width: min(560px, calc(100% - 32px)); padding: 12px 14px; border-radius: 12px;
  background: rgba(18,20,25,.96); border: 1px solid rgba(255,255,255,.14); box-shadow: 0 16px 40px rgba(0,0,0,.5); font-size: 14px; line-height: 1.45; }
.live-recap header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-weight: 700; }
.live-recap header small { font-weight: 400; opacity: .65; }
.live-recap header button { margin-left: auto; border: 0; background: transparent; color: inherit; cursor: pointer; font-size: 18px; line-height: 1; padding: 2px 6px; }
.live-recap p { margin: 0; }
`;

export function initLiveCaptions({ conn, video, key, isHost, notify = () => {}, doc = document }) {
  const style = doc.createElement('style');
  style.textContent = STYLE;
  doc.head.append(style);

  const ccBtn = doc.getElementById('ccBtn'), ccPop = doc.getElementById('ccPop');
  ccBtn?.classList.add('live-dot');

  const recapCard = doc.createElement('section');
  recapCard.className = 'live-recap';
  recapCard.hidden = true;
  recapCard.setAttribute('aria-live', 'polite');
  (doc.getElementById('stage') || doc.body).append(recapCard);

  const track = video.addTextTrack('captions', 'Live captions', 'en');
  track.mode = 'hidden';
  const S = { status: { ok: isHost, active: false, reason: '' }, movieId: null, seen: new Set(), show: pref(), ai: false,
    recap: { state: 'idle', reason: '' }, highlights: { state: 'idle', clips: [], reason: '', movieId: null } };

  const clearCues = () => { for (const cue of [...(track.cues || [])]) track.removeCue(cue); S.seen.clear(); };
  const applyMode = () => {
    const showing = S.ai && S.status.active && S.show;
    if (showing && typeof window !== 'undefined') window.wpSelectSub?.(null, false);
    track.mode = showing ? 'showing' : 'hidden';
  };
  const notified = new Set();
  const report = (kind, reason, messages) => {
    if (!S.ai || !reason || !messages[reason]) return;
    const id = `${S.movieId}:${kind}:${reason}`;
    if (notified.has(id)) return;
    notified.add(id); if (notified.size > 100) notified.delete(notified.values().next().value);
    notify(messages[reason]);
  };
  const liveDot = () => ccBtn?.classList.toggle('on', !!(S.ai && S.status.active));

  function addCues(cues) {
    const Cue = globalThis.VTTCue;
    if (!Cue) return;
    for (const c of cues || []) {
      const id = `${c.start}|${c.text}`;
      if (S.seen.has(id) || !(c.end > c.start)) continue;
      S.seen.add(id);
      try { track.addCue(new Cue(c.start, c.end, String(c.text || ''))); } catch { /* malformed cue */ }
    }
  }

  // Build the extra HTML that joins the existing CC popover's innerHTML.
  function sectionsHtml() {
    if (!S.ai) return '';
    const st = S.status;
    let html = '';
    if (isHost) html += `<button type="button" data-live="toggle" title="Automatically detects spoken languages and generates English captions for the room." ${!st.ok && !st.active ? 'disabled' : ''}>${st.active ? 'Stop live captions' : 'Start live captions'}</button>`;
    if (st.active) html += `<button type="button" data-live="show" title="Show or hide live English captions on your screen." class="${S.show ? 'sel' : ''}">Live English captions</button>`;
    html += `<button type="button" data-live="recap" title="Summarizes dialogue so far without stopping playback." ${S.recap.state === 'working' ? 'disabled' : ''}>${S.recap.state === 'working' ? 'Summarizing…' : 'Catch me up'}</button>`;
    if (isHost) html += `<button type="button" data-live="highlights" title="Finds short clips from moments already watched. Generation uses host resources." ${S.highlights.state === 'working' ? 'disabled' : ''}>${S.highlights.state === 'working' ? 'Finding highlights…' : 'Highlights'}</button>`;
    for (const clip of S.highlights.clips) {
      const href = `${clip.url}${clip.url.includes('?') ? '&' : '?'}k=${encodeURIComponent(key)}`;
      html += `<div class="live-clip"><a href="${esc(href)}" target="_blank" rel="noopener" download="highlight-${esc(clock(clip.t).replace(/:/g, '-'))}.mp4">Clip at ${esc(clock(clip.t))}</a><button type="button" data-seek="${Number(clip.t) || 0}">Jump</button></div>`;
    }
    return html;
  }

  // Detect only EXTERNAL rebuilds of #ccPop (buildCcMenu replaces innerHTML). The observer is
  // disconnected while we add our own section, so it never reacts to its own writes and cannot loop.
  let scheduled = false;
  const MARK = 'wpLiveSection';
  let observer;
  function append() {
    scheduled = false;
    if (!ccPop) return;
    observer?.disconnect();
    try {
      // Remove our previous section (if any) before re-adding, so the sub list above us is preserved.
      ccPop.querySelectorAll('[data-wp-live-section]').forEach(el => el.remove());
      if (!S.ai) return;
      const host = ccPop.ownerDocument.createElement('div');
      host.dataset[MARK] = '1';
      host.innerHTML = sectionsHtml();
      ccPop.append(host);
      if (S.status.active && S.show) {
        ccPop.querySelector?.('[data-sub=""]')?.classList.remove('sel');
        ccBtn?.classList.add('on');
        ccBtn?.setAttribute?.('aria-pressed', 'true');
      }
    } finally { observer?.observe(ccPop, { childList: true, subtree: false }); }
  }
  const schedule = () => { if (scheduled) return; scheduled = true; queueMicrotask(append); };
  if (ccPop && typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(records => {
      // Ignore our own section node additions and removals.
      for (const r of records) {
        for (const n of r.addedNodes) if (!(n.nodeType === 1 && n.dataset?.[MARK])) return schedule();
        for (const n of r.removedNodes) if (!(n.nodeType === 1 && n.dataset?.[MARK])) return schedule();
      }
    });
    observer.observe(ccPop, { childList: true, subtree: false });
  }
  // Our click handler runs after app.js's handler. For data-live and data-seek we act and stop;
  // for data-sub (including the "Off" button) we hide the live caption track so the viewer never
  // sees both at once.
  ccPop?.addEventListener('click', e => {
    const seek = e.target.closest('[data-seek]');
    if (seek) { conn.send({ type: 'cmd', action: 'seek', position: Number(seek.dataset.seek), at: Date.now() }); ccPop.hidden = true; return; }
    const sub = e.target.closest('[data-sub]');
    if (sub) {                                           // CC Off or any saved/provider track clicked
      if (S.show) { S.show = false; savePref(false); applyMode(); schedule(); }
      return;
    }
    const action = e.target.closest('[data-live]')?.dataset.live;
    if (!action) return;
    e.stopPropagation();
    if (action === 'toggle') conn.send({ type: S.status.active ? 'captions-stop' : 'captions-start' });
    else if (action === 'show') {
      S.show = !S.show;
      savePref(S.show);
      // When the user turns live captions ON, also clear the normal subtitle track so only one shows.
      applyMode();
      schedule();
    }
    else if (action === 'recap') { S.recap = { state: 'working', reason: '' }; conn.send({ type: 'recap-request' }); schedule(); }
    else if (action === 'highlights') { S.highlights = { ...S.highlights, state: 'working', reason: '' }; conn.send({ type: 'highlights-generate' }); schedule(); }
  });

  function showRecap(m) {
    recapCard.innerHTML = `<header>Catch me up<small>${m.upTo != null ? `up to ${esc(clock(m.upTo))}` : ''}</small><button type="button" aria-label="Close">×</button></header><p>${esc(m.text)}</p>`;
    recapCard.hidden = false;
    recapCard.querySelector('button').addEventListener('click', () => { recapCard.hidden = true; });
  }

  const applySettings = settings => {
    const on = !!settings?.aiFeatures;
    if (on === S.ai) return;
    S.ai = on;
    if (!on) { clearCues(); recapCard.hidden = true; S.status = { ...S.status, active: false }; S.highlights = { state: 'idle', clips: [], reason: '', movieId: null }; }
    applyMode(); liveDot();
    // Reopen will refresh contents on its next build; also nudge now if open.
    schedule();
  };
  conn.on('settings', m => applySettings(m.settings));
  conn.on('welcome', m => {
    if ((m.movie?.id || null) !== S.movieId) { S.movieId = m.movie?.id || null; clearCues(); }
    applySettings(m.settings);
    conn.send({ type: 'captions-sync' });
  });
  conn.on('movie', m => {
    if ((m.movie?.id || null) === S.movieId) return;
    S.movieId = m.movie?.id || null;
    clearCues();
    recapCard.hidden = true;
    S.highlights = { state: 'idle', clips: [], reason: '', movieId: null };
  });
  conn.on('captions-status', m => { S.status = { ok: !!m.ok, active: !!m.active, reason: m.reason || '' }; applyMode(); liveDot(); report('captions', m.reason, STATUS_TEXT); schedule(); });
  conn.on('live-caption', m => {
    if (m.reset || m.movieId !== S.movieId) { clearCues(); S.movieId = m.movieId; }
    addCues(m.cues);
  });
  conn.on('recap', m => {
    S.recap = { state: 'idle', reason: m.text ? '' : m.reason || 'failed' };
    if (m.text && m.movieId === S.movieId) showRecap(m);
    report('recap', m.reason, RECAP_TEXT);
    if (ccPop && !ccPop.hidden) schedule();
  });
  conn.on('highlights', m => {
    if (m.status === 'working') S.highlights = { ...S.highlights, state: 'working', reason: '' };
    else S.highlights = { state: 'idle', clips: Array.isArray(m.clips) ? m.clips.filter(c => /^\/highlights\//.test(String(c.url || ''))) : [], reason: m.reason || '', movieId: m.movieId || null };
    report('highlights', m.reason, HIGHLIGHT_TEXT);
    if (ccPop && !ccPop.hidden) schedule();
  });
  return { track, state: S };
}
