// Anime: search, watch history, the loading overlay, episode and language switching, and intro/credits skipping.
import { refreshShelf } from './browse.js';
import { noPerm, sendCmd } from './controls.js';
import { $, $$, M, S, api, canControl, conn, esc, fmtTime, isHost, kindOf, localPos, player, remote, stage, video } from './core.js';
import { toast } from './social.js';
import { animeResumeCard, animeSeriesFinished } from '../anime-resume.js';
import { playbackResumeCard, playbackResumeEntries } from '../playback-resume.js';

let animeSeq = 0, animePendingQ = null;
async function animeSearch(q) {
  q = String(q || '').trim();
  if (!q) return;
  const seq = ++animeSeq;
  $('#animeStatus').textContent = `Searching for "${q}"…`;
  if (!isHost) { animePendingQ = q; conn.send({ type: 'anime-search', q }); return; }
  try {
    const r = await api(`/api/anime/search?q=${encodeURIComponent(q)}`);
    if (seq !== animeSeq) return;
    showAnimeResults(q, r.results || []);
  } catch (e) {
    if (seq === animeSeq) $('#animeStatus').textContent = e.message;
  }
}
function onAnimeResults(m) {
  if (isHost || m.q !== animePendingQ) return;
  if (m.error) { $('#animeStatus').textContent = m.error; return; }
  showAnimeResults(m.q, m.results || []);
}
function showAnimeResults(q, list) {
  $('#animeStatus').textContent = list.length ? '' : `Nothing found for "${q}".`;
  $('#animeResults').innerHTML = list.map(a => {
    const count = Math.min(Math.max(1, Number(a.episodes) || 1), 2000);
    const latest = S.animeHistory.find(e => e.anilistId === Number(a.id));
    const selected = latest ? Math.min(count, latest.episode + (latest.completed && latest.episode < count ? 1 : 0)) : 1;
    const epOpts = Array.from({ length: count }, (_, i) => `<option value="${i + 1}"${i + 1 === selected ? ' selected' : ''}>${esc(animeEpisodeLabel(Number(a.id), i + 1))}</option>`).join('');
    const title = esc(a.title);
    return `<div class="anime-card" data-aid="${a.id}" data-mal="${a.mal || 0}" data-episodes="${a.episodes || 0}" data-title="${title}" data-poster="${esc(a.poster || '')}">
    ${a.poster ? `<img src="${esc(a.poster)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
    <div class="meta"><div class="t" data-tip="${title}">${title}</div><div class="m">${esc([a.format, a.year, a.episodes ? a.episodes + ' ep' : ''].filter(Boolean).join(' · '))}</div></div>
    <div class="pick"><select class="anime-ep" aria-label="Episode">${epOpts}</select><select class="anime-lang" aria-label="Sub or dub"><option value="dub"${latest?.language !== 'sub' ? ' selected' : ''}>Dub</option><option value="sub"${latest?.language === 'sub' ? ' selected' : ''}>Sub</option></select></div>
    <button type="button" class="anime-play" aria-label="Play"><svg viewBox="0 0 24 24"><path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/></svg></button></div>`;
  }).join('');
  $('#animeResults').scrollTop = 0;
}
$('#animeForm').addEventListener('submit', e => { e.preventDefault(); animeSearch($('#animeQuery').value); });

function animeAutomationLeader() {
  const leader = S.people.find(person => person.animeLeader);
  return leader ? leader.id === S.me?.id : isHost;
}
function saveAnimeProgress(status = player?.status(), flush = false) {
  if (!animeAutomationLeader() || !conn || !status || S.movie?.kind !== 'anime') return;
  conn.send({ type: 'anime-progress', status, flush });
}
function savePlaybackProgress(status = player?.status(), flush = false) {
  if (!isHost || !conn || !status || !S.movie || S.movie.kind === 'anime') return;
  if (M === remote && (remote.signingIn || remote.st?.ad)) return;
  conn.send({ type: 'playback-progress', status, url: M === remote ? remote.st?.url : '', flush });
}

function selectAnime(message) {
  const episode = Math.max(1, Number(message.ep) || 1);
  const language = message.lang === 'dub' ? 'dub' : 'sub';
  const sameEpisode = S.movie?.kind === 'anime' && S.movie.anilistId === Number(message.anilistId)
    && S.movie.episode === episode && S.movie.language === language;
  showTuneIn(`${message.title || 'Anime'} · Ep ${episode}${language === 'dub' ? ' (Dub)' : ''}`, !sameEpisode);
  saveAnimeProgress(undefined, true);
  conn.send({ type: 'select-anime', ...message });
}
// Save promptly on pause/exit as well as the player's regular reports.
video.addEventListener('pause', () => saveAnimeProgress(undefined, true));
video.addEventListener('ended', () => saveAnimeProgress(undefined, true));
document.addEventListener('visibilitychange', () => { if (document.hidden) saveAnimeProgress(undefined, true); });
window.addEventListener('pagehide', () => saveAnimeProgress(undefined, true));
window.addEventListener('pagehide', () => savePlaybackProgress(undefined, true));
document.addEventListener('visibilitychange', () => { if (document.hidden) savePlaybackProgress(undefined, true); });

function animeEpisodeLabel(id, episode) {
  const saved = S.animeHistory.find(e => e.anilistId === id && e.episode === episode);
  return `Ep ${episode}${saved?.completed ? ' · Watched' : saved?.position > 0 ? ` · ${fmtTime(saved.position)}` : ''}`;
}

function renderAnimeHistory() {
  renderAnimeEpisodePicker();
  const groups = new Map();
  for (const entry of S.animeHistory) {
    if (!groups.has(entry.anilistId)) groups.set(entry.anilistId, []);
    groups.get(entry.anilistId).push(entry);
  }
  const visible = [...groups.values()].filter(entries => !S.animeContinueHidden.includes(entries[0].anilistId) && !animeSeriesFinished(entries));
  const cards = visible.map(entries => ({ at: entries[0].updatedAt, html: animeResumeCard({ ...entries[0], canDismiss: isHost, poster: entries.find(entry => entry.poster)?.poster || '' }) }));
  for (const entry of playbackResumeEntries(S.playbackHistory)) {
    cards.push({ at: entry.updatedAt, html: playbackResumeCard(entry, isHost) });
  }
  cards.sort((a, b) => b.at - a.at);
  const continueBox = $('#animeContinue');
  const scrollLeft = continueBox.querySelector('.anime-resume-grid')?.scrollLeft || 0;
  const homeFocus = document.activeElement?.closest('#animeContinue button');
  const focusedKey = homeFocus ? { ...homeFocus.dataset } : null;
  continueBox.hidden = !cards.length;
  $('#stageEmpty').classList.toggle('has-history', !!cards.length);
  stage.classList.toggle('has-history', !!cards.length);
  continueBox.innerHTML = cards.length ? `<div class="anime-resume-heading"><div><p>Your watch history</p><h2>Continue watching</h2></div></div><div class="shelf-frame"><div class="shelf-nav" hidden><button type="button" data-shelf-page="-1" aria-label="Previous continue watching titles" aria-controls="animeResumeShelf"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6-6 6 6 6M4 12h16"/></svg></button><button type="button" data-shelf-page="1" aria-label="Next continue watching titles" aria-controls="animeResumeShelf"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6 6 6-6 6M20 12H4"/></svg></button></div><div class="anime-resume-grid" id="animeResumeShelf" tabindex="0" role="region" aria-label="Continue watching titles">${cards.map(card => card.html).join('')}</div></div>` : '';
  if (cards.length) continueBox.querySelector('.anime-resume-grid').scrollLeft = scrollLeft;
  if (focusedKey) {
    const replacement = $$('#animeContinue button').find(button => Object.entries(focusedKey).every(([key, value]) => button.dataset[key] === value));
    (replacement || $('#animeContinue [data-history-play]') || $('#stageEmpty .empty-actions button'))?.focus({ preventScroll: true });
  }
  for (const card of $$('#animeResults .anime-card')) {
    for (const option of card.querySelectorAll('.anime-ep option')) option.textContent = animeEpisodeLabel(Number(card.dataset.aid), Number(option.value));
  }
  requestAnimationFrame(() => refreshShelf(continueBox, '.anime-resume-grid'));
}

function onAnimeHistoryClick(event) {
  const playback = event.target.closest('[data-playback-play], [data-playback-dismiss]');
  if (playback) {
    if (playback.dataset.playbackDismiss && !isHost) return;
    conn.send({ type: playback.dataset.playbackDismiss ? 'playback-dismiss' : 'select-playback', id: playback.dataset.playbackDismiss || playback.dataset.playbackPlay });
    return;
  }
  const button = event.target.closest('[data-history-play], [data-history-dismiss]');
  if (!button) return;
  const id = Number(button.dataset.historyPlay || button.dataset.historyDismiss);
  if (button.dataset.historyDismiss) {
    if (!isHost) return;
    conn.send({ type: 'anime-continue-dismiss', anilistId: id });
    return;
  }
  const ep = Number(button.dataset.episode);
  const saved = S.animeHistory.find(e => e.anilistId === id && e.episode === ep) || S.animeHistory.find(e => e.anilistId === id);
  if (!saved) return;
  selectAnime({ anilistId: id, malId: saved.malId, ep, episodes: saved.episodes,
    lang: saved.language, title: saved.animeTitle, poster: saved.poster, restart: button.dataset.restart === 'true', resume: true });
}
$('#animeContinue').addEventListener('click', onAnimeHistoryClick);
$('#animeContinue').addEventListener('error', event => { if (event.target.matches('img')) event.target.hidden = true; }, true);

const nameTip = Object.assign(document.createElement('div'), { className: 'name-tip', hidden: true });
document.body.appendChild(nameTip);
function placeNameTip(target) {
  const text = target.dataset.tip || target.textContent;
  nameTip.textContent = text;
  nameTip.hidden = false;
  const r = target.getBoundingClientRect();
  const w = Math.min(320, nameTip.offsetWidth);
  const left = Math.max(8, Math.min(r.left, innerWidth - w - 8));
  const h = nameTip.offsetHeight;
  const above = r.top - h - 10;
  const top = above >= 8 ? above : r.bottom + 10;
  nameTip.style.left = left + 'px';
  nameTip.style.top = top + 'px';
}
$('#animeResults').addEventListener('pointerover', e => {
  const t = e.target.closest('.anime-card .t');
  if (!t || t.scrollWidth <= t.clientWidth + 1) return;
  placeNameTip(t);
});
$('#animeResults').addEventListener('pointerout', e => {
  if (e.target.closest('.anime-card .t') && !e.relatedTarget?.closest('.anime-card .t')) nameTip.hidden = true;
});
$('#animeResults').addEventListener('scroll', () => { nameTip.hidden = true; }, { passive: true });

$('#animeResults').addEventListener('click', e => {
  const btn = e.target.closest('.anime-play');
  if (!btn) return;
  const card = btn.closest('.anime-card');
  const ep = Math.max(1, parseInt(card.querySelector('.anime-ep').value, 10) || 1);
  const lang = card.querySelector('.anime-lang').value === 'sub' ? 'sub' : 'dub';
  const title = card.dataset.title || 'Anime';
  selectAnime({ anilistId: Number(card.dataset.aid), malId: Number(card.dataset.mal) || 0, ep, episodes: Number(card.dataset.episodes) || 0, lang, title, poster: card.dataset.poster || '' });
});

const tuneIn = { el: $('#tuneIn'), title: $('#tuneInTitle'), until: 0, waitTimer: 0, hideTimer: 0, awaitingMovie: false };
const TUNE_IN_MIN = 700; // long enough not to flash; the picture is not held back beyond it
function showTuneIn(label, awaitingMovie = false) {
  clearTimeout(tuneIn.waitTimer); clearTimeout(tuneIn.hideTimer);
  tuneIn.waitTimer = 0; tuneIn.hideTimer = 0;
  tuneIn.awaitingMovie = awaitingMovie;
  tuneIn.el.hidden = false;
  tuneIn.el.classList.remove('leaving');
  tuneIn.title.textContent = label;
  tuneIn.until = performance.now() + TUNE_IN_MIN;
}
function showTuneInForMovie(movie) {
  if (tuneIn.awaitingMovie && !tuneIn.el.hidden) {
    tuneIn.awaitingMovie = false;
    tuneIn.title.textContent = movie.title;
    // Keep the transition visible while the newly accepted episode attaches.
    tuneIn.until = Math.max(tuneIn.until, performance.now() + 300);
  } else showTuneIn(movie.title);
}
function hideTuneIn(force = false) {
  if (tuneIn.el.hidden) return;
  if (force) {
    clearTimeout(tuneIn.waitTimer); clearTimeout(tuneIn.hideTimer);
    tuneIn.waitTimer = 0; tuneIn.hideTimer = 0;
    tuneIn.awaitingMovie = false;
    tuneIn.el.hidden = true; tuneIn.el.classList.remove('leaving'); return;
  }
  if (tuneIn.awaitingMovie) return;
  // Progress events can arrive faster than the exit animation. Once leaving, keep
  // its original deadline; restarting it on every report traps the overlay onscreen.
  if (tuneIn.el.classList.contains('leaving')) return;
  const now = performance.now();
  if (now < tuneIn.until) {
    if (!tuneIn.waitTimer) tuneIn.waitTimer = setTimeout(() => { tuneIn.waitTimer = 0; hideTuneIn(); }, tuneIn.until - now);
    return;
  }
  clearTimeout(tuneIn.waitTimer); tuneIn.waitTimer = 0;
  tuneIn.el.classList.add('leaving');
  tuneIn.hideTimer = setTimeout(() => { tuneIn.el.hidden = true; tuneIn.el.classList.remove('leaving'); }, 300);
}
video.addEventListener('playing', () => hideTuneIn());
video.addEventListener('loadeddata', () => { if (video.readyState >= 3) hideTuneIn(); });

let episodePickerKey = '';
function renderAnimeEpisodePicker() {
  const m = S.movie;
  const show = !!m && kindOf(m) === 'anime' && !!m.anilistId;
  $('#animeEpisodePicker').hidden = !show;
  $('#animeEpisodeSelectInline').hidden = !show;
  if (!show) { episodePickerKey = ''; return; }
  const history = S.animeHistory.filter(entry => entry.anilistId === m.anilistId);
  const current = Math.max(1, Number(m.episode) || 1);
  const count = Math.min(100000, Math.max(current, Number(m.episodes) || 0, ...history.map(entry => entry.episode)));
  const signature = `${m.anilistId}:${current}:${count}:${history.map(entry => `${entry.episode}/${entry.completed}/${Math.floor(entry.position)}`).join(',')}`;
  if (signature === episodePickerKey) return;
  const selects = [$('#animeEpisodeSelect'), $('#animeEpisodeSelectInline')];
  // Progress reports must not rebuild a native picker while someone is choosing.
  if (episodePickerKey.startsWith(`${m.anilistId}:${current}:${count}:`) && selects.includes(document.activeElement)) return;
  episodePickerKey = signature;
  const watched = new Map(history.map(entry => [entry.episode, entry]));
  const options = Array.from({ length: count }, (_, i) => {
    const episode = i + 1, saved = watched.get(episode);
    return `<option value="${episode}">Ep ${episode}${saved?.completed ? ' · Watched' : saved?.position > 0 ? ` · ${fmtTime(saved.position)}` : ''}</option>`;
  }).join('');
  for (const select of selects) {
    select.innerHTML = options;
    select.value = String(current);
    select.title = `Episode ${current}${m.episodes ? ` of ${m.episodes}` : ''} · choose an episode`;
  }
}
function chooseAnimeEpisode(episode) {
  const m = S.movie;
  if (!m || kindOf(m) !== 'anime' || !m.anilistId || !Number.isInteger(episode) || episode < 1) return;
  if (Number(m.episodes) > 0 && episode > Number(m.episodes)) return;
  if (episode === Number(m.episode)) return;
  selectAnime({ anilistId: m.anilistId, malId: m.malId || 0, ep: episode, episodes: m.episodes || 0,
    lang: m.language, title: m.animeTitle || 'Anime', resume: true });
}
for (const id of ['#animeEpisodeSelect', '#animeEpisodeSelectInline']) {
  $(id).addEventListener('change', event => {
    chooseAnimeEpisode(Number(event.target.value));
    event.target.value = String(S.movie?.episode || 1);
  });
}
function renderAnimeOverlay() {
  const button = $('#animeNext');
  const previous = $('#animePrev');
  const toggle = $('#animeLangToggle');
  const catalogToggle = $('#catalogLangToggle');
  const m = S.movie;
  renderAnimeEpisodePicker();
  const series = m && (kindOf(m) === 'anime' || kindOf(m) === 'catalog' && m.catalogRef?.type === 'tv');
  button.hidden = previous.hidden = !series;
  const current = Number(kindOf(m) === 'catalog' ? m?.catalogRef?.episode : m?.episode) || 1;
  previous.disabled = current <= 1;
  previous.title = current > 1 ? `Previous episode · ${current - 1}` : 'First episode';
  if (m && kindOf(m) === 'catalog') {
    toggle.hidden = true;
    const languages = Array.isArray(m.languages) ? m.languages : [];
    catalogToggle.hidden = languages.length < 2;
    catalogToggle.innerHTML = languages.map(language => `<button type="button" data-lang="${esc(language.code)}" aria-pressed="${language.code === m.language}">${esc(language.label)}</button>`).join('');
    const isSeries = m.catalogRef?.type === 'tv';
    button.hidden = !isSeries;
    button.disabled = !m.hasNext;
    button.title = m.hasNext ? `Next episode · ${Number(m.catalogRef.episode) + 1}` : 'Last available episode';
    return;
  }
  catalogToggle.hidden = true;
  catalogToggle.innerHTML = '';
  const isAnime = m && (kindOf(m) === 'anime');
  if (!isAnime) { button.disabled = true; toggle.hidden = true; return; }
  const episode = Math.max(1, Number(m.episode) || 1);
  const atEnd = Number(m.episodes) > 0 && episode >= Number(m.episodes);
  button.disabled = atEnd;
  button.title = atEnd ? 'Last episode' : `Next episode · ${episode + 1}`;
  const lang = m.language === 'dub' ? 'dub' : 'sub';
  toggle.hidden = false;
  toggle.dataset.lang = lang;
  toggle.querySelectorAll('.l-opt').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
}
$('#animeNext').addEventListener('click', () => {
  const m = S.movie;
  if (m && kindOf(m) === 'catalog' && m.catalogRef?.type === 'tv' && m.hasNext) {
    conn.send({ type: 'select-catalog', ref: { ...m.catalogRef, episode: Number(m.catalogRef.episode) + 1 }, language: m.language, title: m.catalogTitle || 'TV series' });
    return;
  }
  if (!m || !(kindOf(m) === 'anime') || !m.anilistId) return;
  const episode = Math.max(1, Number(m.episode) || 1);
  if (Number(m.episodes) > 0 && episode >= Number(m.episodes)) return;
  chooseAnimeEpisode(episode + 1);
});
$('#animePrev').addEventListener('click', () => {
  const m = S.movie;
  if (kindOf(m) === 'catalog' && m.catalogRef?.type === 'tv' && Number(m.catalogRef.episode) > 1) {
    conn.send({ type: 'select-catalog', ref: { ...m.catalogRef, episode: Number(m.catalogRef.episode) - 1 }, language: m.language, title: m.catalogTitle || 'TV series' });
  } else chooseAnimeEpisode(Number(m?.episode) - 1);
});
$('#catalogLangToggle').addEventListener('click', e => {
  const button = e.target.closest('[data-lang]');
  const m = S.movie;
  if (!button || !m || kindOf(m) !== 'catalog' || !m.catalogRef) return;
  if (!canControl()) return noPerm('playback');
  const language = button.dataset.lang;
  if (!language || language === m.language) return;
  showTuneIn(`${m.catalogTitle || m.title} · ${button.textContent}`);
  conn.send({ type: 'select-catalog', ref: m.catalogRef, language, title: m.catalogTitle || m.title });
});
$('#animeLangToggle').addEventListener('click', e => {
  const b = e.target.closest('.l-opt');
  if (!b) return;
  const m = S.movie;
  if (!canControl()) return noPerm('playback');
  if (!m || !(kindOf(m) === 'anime') || !m.anilistId) return;
  const next = b.dataset.lang === 'dub' ? 'dub' : 'sub';
  if (next === (m.language === 'dub' ? 'dub' : 'sub')) return;
  const episode = Math.max(1, Number(m.episode) || 1);
  const title = m.animeTitle || 'Anime';
  selectAnime({ anilistId: m.anilistId, malId: m.malId || 0, ep: episode, episodes: m.episodes || 0, lang: next, title });
});

/* Manual skips follow playback permissions; one elected viewer drives automation. */
const AUTO_SKIP_DELAY = 3000; // the elected viewer waits before advancing at the outro
const skipBtn = $('#animeSkip');
skipBtn.appendChild(Object.assign(document.createElement('span'), { className: 'count' }));
const autoSkipBtn = $('#autoSkipBtn');
const autoSkipOn = () => S.settings?.animeAutoSkip !== false;
let skipCtx = null, skipAutoTimer = null;

function animeSkipTarget() {
  const m = S.movie;
  if (!m || kindOf(m) !== 'anime') return null;            // native HLS only; never the iframe fallback
  const pos = localPos();
  const inRange = r => r && Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start && pos >= r.start && pos < r.end - 0.3;
  if (inRange(m.intro)) return { kind: 'intro', label: 'Skip Intro', to: m.intro.end };
  if (inRange(m.outro)) {
    const ep = Math.max(1, Number(m.episode) || 1);
    const hasNext = Number(m.episodes) > 0 && ep < Number(m.episodes) && m.anilistId;
    return hasNext ? { kind: 'outro', label: 'Next Episode', next: true }
      : { kind: 'outro', label: 'Skip Credits', to: m.outro.end };
  }
  return null;
}
function doAnimeSkip(t) {
  if (!t) return;
  if (!canControl()) { noPerm('playback'); return; }
  if (t.next) {
    const m = S.movie, ep = Math.max(1, Number(m.episode) || 1);
    selectAnime({ anilistId: m.anilistId, malId: m.malId || 0, ep: ep + 1, episodes: m.episodes || 0, lang: m.language, title: m.animeTitle || 'Anime' });
  } else if (Number.isFinite(t.to)) {
    sendCmd('seek', t.to);                                 // host-authoritative seek -> syncs to the whole room
  }
}
function hideSkip() { if (!skipBtn.hidden) skipBtn.hidden = true; skipBtn.classList.remove('counting'); }
function stopCount() { if (skipAutoTimer) { clearTimeout(skipAutoTimer); skipAutoTimer = null; } skipBtn.classList.remove('counting'); }

function updateAnimeSkip() {
  if (!canControl()) { stopCount(); hideSkip(); skipCtx = null; return; }
  const t = animeSkipTarget();
  if (!t) { stopCount(); hideSkip(); skipCtx = null; return; }
  const playing = !!(S.state && S.state.playing);
  const auto = autoSkipOn() && animeAutomationLeader();
  if (!skipCtx || skipCtx.kind !== t.kind || skipCtx.movieId !== S.movie.id) {
    stopCount(); skipCtx = { movieId: S.movie.id, kind: t.kind, cancelled: false, armed: false, done: false };
  }

  // auto ON + intro + playing -> skip directly, no overlay
  if (t.kind === 'intro' && auto && playing && !skipCtx.cancelled && !skipCtx.done) {
    hideSkip(); doAnimeSkip(t); toast('Skipped intro', { timeout: 2000 });
    skipCtx.done = true; return;
  }
  if (skipCtx.done) { hideSkip(); return; }                // intro skip issued; waiting for the seek to land

  if (skipBtn.hidden) { skipBtn.hidden = false; skipBtn.classList.remove('counting'); void skipBtn.offsetWidth; }
  skipBtn.querySelector('.lbl').textContent = t.label;

  // outro auto-advance countdown: auto ON + playing + not cancelled
  const wantCount = t.kind === 'outro' && t.next && auto && playing && !skipCtx.cancelled;
  if (wantCount && !skipCtx.armed) {
    skipCtx.armed = true;
    skipBtn.style.setProperty('--count-dur', (AUTO_SKIP_DELAY / 1000) + 's');
    skipBtn.classList.add('counting');
    skipAutoTimer = setTimeout(() => {
      skipAutoTimer = null; skipBtn.classList.remove('counting');
      const now = animeSkipTarget();
      if (now && now.next && autoSkipOn() && animeAutomationLeader() && canControl() && S.state && S.state.playing && !(skipCtx && skipCtx.cancelled)) {
        doAnimeSkip(now); toast('Next episode', { timeout: 2500 });
      }
    }, AUTO_SKIP_DELAY);
  } else if (!wantCount && skipCtx.armed) {
    skipCtx.armed = false; stopCount();
    if (!playing) skipCtx.cancelled = true;                // pausing (e.g. clicking the screen) = "not now"
  }
}
skipBtn.addEventListener('click', e => {
  e.stopPropagation();
  const t = animeSkipTarget();
  stopCount(); if (skipCtx) { skipCtx.armed = false; skipCtx.done = true; }
  doAnimeSkip(t);
});
setInterval(updateAnimeSkip, 400);
video.addEventListener('ended', () => {
  const m = S.movie;
  if (kindOf(m) !== 'anime' || !animeAutomationLeader() || !canControl() || !autoSkipOn()) return;
  if (m.anilistId && (!m.episodes || Number(m.episode) < Number(m.episodes))) $('#animeNext').click();
});

/* All controllers share one toggle; only the elected viewer executes automatic skips. */
function renderAutoSkipBtn() {
  if (!autoSkipBtn) return;
  const show = S.movie && kindOf(S.movie) === 'anime';
  if (autoSkipBtn.hidden !== !show) autoSkipBtn.hidden = !show;
  const on = autoSkipOn();
  autoSkipBtn.disabled = !canControl();
  autoSkipBtn.classList.toggle('on', on);
  autoSkipBtn.setAttribute('aria-pressed', String(on));
  autoSkipBtn.title = on ? 'Auto-skip intros & credits: on' : 'Auto-skip intros & credits: off';
}
autoSkipBtn?.addEventListener('click', () => {
  if (!canControl()) return noPerm('playback');
  conn.send({ type: 'anime-auto-skip', enabled: !autoSkipOn() });
});

export { hideTuneIn, onAnimeResults, renderAnimeHistory, renderAnimeOverlay, renderAutoSkipBtn, saveAnimeProgress, savePlaybackProgress, showTuneIn, showTuneInForMovie, tuneIn, updateAnimeSkip };
