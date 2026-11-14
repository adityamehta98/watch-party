// Picking something to watch: the YouTube browser, Movies & TV search and the home shelf's paging.
import { hideTuneIn, saveAnimeProgress, savePlaybackProgress, showTuneIn } from './anime.js';
import { closePops, poke, sendCmd } from './controls.js';
import { $, $$, S, api, app, avatar, canControl, conn, esc, fmtTime, isHost, isTheater, kindOf, remote, stage } from './core.js';
import { enterTheater, theaterPost } from './services.js';
import { setTab, togglePip } from './social.js';
import { SERVICE_COLORS, SERVICE_HOMES, SERVICE_NAMES, SERVICE_SEARCH, extOutdated, loadYouTubeApi } from '../media.js';
import { youtubeEndCards } from '../youtube-end.js';

let pendingCatalogService = null;

const YT_HOME = 'Popular videos';
function onYouTubeEnded() {
  if (S.movie?.kind !== 'youtube') return;
  $('#ytEndScreen').hidden = false;
  $('#ytEndStatus').textContent = 'Finding related videos…';
  $('#ytEndVideos').innerHTML = youtubeEndCards(S.youtubeRecommendations || [], S.movie.videoId);
  if (matchMedia('(min-width: 1100px)').matches) openYouTube();
  else { closeYouTube(); ytBrowse(ytActivePlaylist ? 'playlist' : 'related', ytActivePlaylist); }
  poke();
}
$('#ytReplay').addEventListener('click', () => { if (canControl()) { $('#ytEndScreen').hidden = true; sendCmd('play', 0); } });
$('#ytEndBrowse').addEventListener('click', openYouTube);
$('#ytEndVideos').addEventListener('click', e => {
  const b = e.target.closest('[data-yid]');
  if (b) conn.send({ type: 'select-url', url: `https://www.youtube.com/watch?v=${b.dataset.yid}` });
});
function openYouTube() {
  $('#ytBrowser').hidden = false;
  stage.classList.toggle('youtube-browse-watch', S.movie?.kind === 'youtube');
  setTab('chat');
  loadYouTubeApi().catch(() => {}); // fetch the player script while the viewer is still choosing
  // The search box takes the keyboard only while nothing plays: beside a playing video the keys belong to the player.
  if (S.movie?.kind === 'youtube') { $('#ytQuery').blur(); ytBrowse(ytActivePlaylist ? 'playlist' : 'related', ytActivePlaylist); }
  else {
    $('#ytQuery').focus();
    if (!$('#ytResults').childElementCount) ytHome();
  }
}
// Home follows the room's taste: videos like the last one it watched, popular ones for a new room.
function ytHome() {
  const id = S.playbackHistory.map(entry => entry.kind === 'youtube' && !entry.hidden && /[?&]v=([\w-]{11})/.exec(entry.url)?.[1]).find(Boolean);
  ytSearch(YT_HOME, id ? { mode: 'home', id } : {});
}
function closeYouTube() { $('#ytBrowser').hidden = true; stage.classList.remove('youtube-browse-watch'); }
let ytSeq = 0;
let ytView = 'search';
let ytActivePlaylist = '';
function ytBrowse(mode, id = '') {
  ytActivePlaylist = mode === 'playlist' ? id : '';
  if (mode === 'history') {
    // The room's saved playback history already holds every YouTube video it watched, newest first.
    ytSeq++; ytMark(mode);
    return showYtResults(S.playbackHistory.filter(entry => entry.kind === 'youtube' && !entry.hidden).map(entry => ({
      id: /[?&]v=([\w-]{11})/.exec(entry.url)?.[1], title: entry.title, thumb: entry.poster, duration: fmtTime(entry.duration),
      when: `Watched ${new Date(entry.updatedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}` })).filter(video => video.id));
  }
  if (mode === 'related' && !S.movie?.videoId) return ytMessage('Play a video to see more like it.');
  ytSearch(mode === 'related' ? S.movie.title : mode === 'playlist' ? 'Playlist' : $('#ytQuery').value || S.movie?.title || 'Popular playlists', { mode, id: id || (mode === 'related' ? S.movie.videoId : '') });
}
async function ytSearch(q, options = {}) {
  q = String(q || '').trim();
  if (!q) return;
  // a pasted link plays straight away
  if (!options.mode && (/^https?:\/\//i.test(q) || /^(?:www\.)?(?:youtube\.com|youtu\.be)\//i.test(q))) {
    try { const link = new URL(q); if (/(^|\.)(youtube\.com|youtu\.be)$/.test(link.hostname) && link.searchParams.has('list')) { ytBrowse('playlist', link.searchParams.get('list')); return; } } catch {}
    conn.send({ type: 'select-url', url: q }); closeYouTube(); $('#ytQuery').value = ''; return;
  }
  const seq = ++ytSeq;
  ytMark(options.mode || 'search', q);
  ytMessage('', '<div class="yt-card skel"><div class="th"></div><div class="t"></div><div class="m"></div></div>'.repeat(8));
  // Guests search through the host's PC too (over the room connection).
  if (!isHost) { ytPendingQ = q; conn.send({ type: 'yt-search', q, ...options, request: seq }); return; }
  try {
    const r = await api(`/api/youtube/search?${new URLSearchParams({ q, ...options })}`);
    if (seq === ytSeq) showYtResults(r.results || []);
  } catch (e) {
    if (seq === ytSeq) ytMessage(e.message);
  }
}
function ytMark(view, q) {
  ytView = view;
  for (const b of $$('#ytChips button')) b.classList.toggle('selected', b.dataset.ytView ? b.dataset.ytView === view : ['search', 'home'].includes(view) && (b.dataset.yq || YT_HOME) === q);
}
function ytMessage(text, results = '') { $('#ytStatus').textContent = text; $('#ytResults').innerHTML = results; }
let ytPendingQ = null;
function onYtResults(m) {
  if (isHost || m.q !== ytPendingQ || m.request != null && m.request !== ytSeq) return;
  if (m.error) return ytMessage(m.error);
  showYtResults(m.results || []);
}
function showYtResults(list) {
  if (S.movie?.kind === 'youtube' && ['related', 'playlist'].includes(ytView)) {
    S.youtubeRecommendations = list;
    $('#ytEndVideos').innerHTML = youtubeEndCards(list, S.movie.videoId);
    $('#ytEndStatus').textContent = list.length ? 'Choose a video to watch with the room.' : 'No related videos available. Search YouTube below.';
  }
  ytMessage(!list.length ? ytView === 'history' ? 'Videos the room watches show up here.' : `No ${ytView === 'playlists' ? 'public playlists' : 'videos'} available. Try another search.` : ytView === 'playlist' ? `Playlist · ${list.length} videos` : '',
    list.map(v => `<button type="button" class="yt-card" ${v.playlist ? 'data-yplaylist' : 'data-yid'}="${esc(v.id)}" title="${esc(v.title)}">
      <div class="th"><img src="${esc(v.thumb)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">${v.live ? '<span class="dur live">LIVE</span>' : v.duration ? `<span class="dur">${esc(v.duration)}</span>` : ''}</div>
      <div class="yt-meta">${v.channel ? avatar(v.channel) : ''}<div><div class="t">${esc(v.title)}</div><div class="m">${esc(v.channel || '')}</div><div class="m">${esc([v.views, v.when].filter(Boolean).join(' • '))}</div></div></div></button>`).join(''));
  $('#ytResults').scrollTop = 0;
}
$('#ytSearchForm').addEventListener('submit', e => { e.preventDefault(); ytSearch($('#ytQuery').value); });
$('#ytChips').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.ytView) ytBrowse(b.dataset.ytView);
  else { $('#ytQuery').value = b.dataset.yq; if (b.dataset.yq) ytSearch(b.dataset.yq); else ytHome(); }
});
$('#ytResults').addEventListener('click', e => {
  const playlist = e.target.closest('[data-yplaylist]');
  if (playlist) { ytBrowse('playlist', playlist.dataset.yplaylist); return; }
  const b = e.target.closest('[data-yid]');
  if (!b) return;
  conn.send({ type: 'select-url', url: `https://www.youtube.com/watch?v=${b.dataset.yid}` });
  if (ytView !== 'playlist') closeYouTube();
});
$('#ytClose').addEventListener('click', closeYouTube);
$('#ytOpen').addEventListener('click', openYouTube);
$('#ytBrowser').addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); closeYouTube(); } });

let catalogSeq = 0, catalogRequestSeq = 0;
const catalogRequests = new Map();
const catalogItems = new Map();

function refreshShelf(root, selector) {
  const list = root.querySelector(selector), nav = root.querySelector('.shelf-nav');
  if (!list || !nav) return;
  const max = Math.max(0, list.scrollWidth - list.clientWidth);
  nav.hidden = max < 2;
  nav.querySelector('[data-shelf-page="-1"]').disabled = list.scrollLeft < 2;
  nav.querySelector('[data-shelf-page="1"]').disabled = list.scrollLeft >= max - 2;
}
function wireShelf(root, selector) {
  const refresh = () => refreshShelf(root, selector);
  const move = direction => {
    const list = root.querySelector(selector);
    if (!list) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches || app.classList.contains('motion-off');
    const cards = [...list.querySelectorAll('.anime-resume-card')];
    const stride = cards.length > 1 ? cards[1].offsetLeft - cards[0].offsetLeft : list.clientWidth;
    const distance = Math.max(1, Math.floor(list.clientWidth / stride)) * stride;
    const target = Math.max(0, Math.min(list.scrollWidth - list.clientWidth, list.scrollLeft + direction * distance));
    if (!reduced) {
      const arriving = cards.filter(card => card.offsetLeft + card.offsetWidth > target && card.offsetLeft < target + list.clientWidth);
      arriving.forEach((card, index) => {
        const art = card.querySelector('.anime-resume-art');
        if (!art?.animate) return;
        art.getAnimations().forEach(animation => animation.cancel());
        art.animate([
          { opacity: .65, transform: `translateX(${direction * 14}px) scale(.975)` },
          { opacity: 1, transform: 'translateX(0) scale(1)' },
        ], { duration: 520, delay: index * 35, easing: 'cubic-bezier(.22, 1, .36, 1)' });
      });
    }
    list.scrollTo({ left: target, behavior: reduced ? 'auto' : 'smooth' });
  };
  root.addEventListener('click', event => {
    const button = event.target.closest('[data-shelf-page]');
    if (button) move(Number(button.dataset.shelfPage));
  });
  root.addEventListener('scroll', refresh, true);
  root.addEventListener('keydown', event => {
    if (!event.target.matches(selector) || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation(); move(event.key === 'ArrowRight' ? 1 : -1);
  });
  if (window.ResizeObserver) new ResizeObserver(refresh).observe(root);
}
wireShelf($('#animeContinue'), '.anime-resume-grid');

function launchCatalogService(id, item) {
  const url = SERVICE_SEARCH[id] ? SERVICE_SEARCH[id](encodeURIComponent(item.title)) : SERVICE_HOMES[id];
  if (!url) return;
  hideTuneIn(true);
  const newTab = id !== 'netflix' && $('#svcNewTab').checked;
  pendingCatalogService = { id, url, title: item.title, newTab, at: Date.now() };
  // Commit to the room first so the extension is watching the selected service when it opens.
  conn.send({ type: 'select-url', url, browsing: true, title: item.title, launchTitle: item.title, playbackRef: { title: item.title, tmdbId: item.tmdbId, type: item.type, year: item.year } });
  if (newTab && !isTheater && remote?.present && !extOutdated(remote.version)) {
    togglePip({ keep: true, quiet: true }); remote.openPanel();
  }
  finishCatalogServiceLaunch(); // A repeated pick may already be the room's accepted service URL.
}
function finishCatalogServiceLaunch() {
  const pending = pendingCatalogService, movie = S.movie;
  if (!pending) return;
  if (Date.now() - pending.at > 10000) { pendingCatalogService = null; return; }
  const key = value => { const url = new URL(value); url.pathname = url.pathname.replace(/\/+$/, '') || '/'; url.searchParams.sort(); return url.href; };
  if (kindOf(movie) !== 'service' || movie.service !== pending.id || key(movie.url) !== key(pending.url)) return;
  if (!remote?.present || extOutdated(remote.version)) return; // The service panel provides setup or update steps.
  pendingCatalogService = null;
  if (isTheater && !S.netflixExternal) theaterPost({ wpTheater: 'goto', url: movie.url });
  else if (movie.service === 'netflix' && S.netflixExternal) remote.openTab();
  else if (pending.newTab) remote.post({ type: 'open', service: movie.service, url: movie.url });
  else enterTheater();
}

function onCatalogResponse(message) {
  const pending = catalogRequests.get(message.requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  catalogRequests.delete(message.requestId);
  if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
}

function catalogRequest(op, params = {}) {
  if (isHost) {
    if (op === 'search') return api(`/api/catalog/search?q=${encodeURIComponent(params.q || '')}`).then(data => data.results || []);
    if (op === 'details') return api(`/api/catalog/details?type=${encodeURIComponent(params.mediaType || '')}&id=${encodeURIComponent(params.tmdbId || '')}`).then(data => data.result);
    if (op === 'season') return api(`/api/catalog/season?id=${encodeURIComponent(params.tmdbId || '')}&season=${encodeURIComponent(params.season || '')}`).then(data => data.result);
    if (op === 'providers') return api(`/api/catalog/providers?type=${encodeURIComponent(params.mediaType || '')}&id=${encodeURIComponent(params.tmdbId || '')}`).then(data => data.result);
  }
  const requestId = `ct${Date.now().toString(36)}${(++catalogRequestSeq).toString(36)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { catalogRequests.delete(requestId); reject(new Error('Movies & TV request timed out.')); }, 15000);
    catalogRequests.set(requestId, { resolve, reject, timer });
    conn.send({ type: 'catalog-query', op, requestId, ...params });
  });
}

const languageOptions = languages => (languages || []).map(language => `<option value="${esc(language.code)}">${esc(language.label)}${language.bestQuality ? ` · ${language.bestQuality >= 2160 ? '4K' : language.bestQuality + 'p'}` : ''}</option>`).join('');

function showCatalogResults(query, list) {
  const results = $('#catalogResults');
  catalogItems.clear();
  $('#catalogStatus').textContent = list.length ? '' : `Nothing found for "${query}".`;
  results.innerHTML = list.map(item => {
    const key = item.type === 'free' ? `free:${item.freeId}` : `${item.type}:${item.tmdbId}`;
    catalogItems.set(key, item);
    const ready = !!item.hasSources;
    const meta = [item.type === 'tv' ? 'Series' : item.type === 'free' ? 'Free media' : 'Movie', item.year, item.rating ? `★ ${Number(item.rating).toFixed(1)}` : ''].filter(Boolean).join(' · ');
    const attribution = item.attribution ? `<div class="catalog-attribution">${item.attribution.creator ? `${esc(item.attribution.creator)} · ` : ''}<a href="${esc(item.attribution.licenseUrl)}" target="_blank" rel="noopener noreferrer">${esc(item.attribution.licenseLabel)}</a> · <a href="${esc(item.attribution.sourcePage)}" target="_blank" rel="noopener noreferrer">Internet Archive</a></div>` : '';
    return `<article class="anime-card catalog-card${item.poster ? '' : ' no-poster'}" data-catalog-key="${esc(key)}">
      ${item.poster ? `<img src="${esc(item.poster)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
      <div class="meta"><div class="t" data-tip="${esc(item.title)}">${esc(item.title)}</div><div class="m">${esc(meta)}</div>${attribution}</div>
      ${ready
        ? `<div class="catalog-actions"><button type="button" class="btn sm primary catalog-open">${item.type === 'tv' ? 'Choose episode' : 'Choose language'}</button><span class="source-note ready">Ready to play</span></div>`
        : item.type === 'free'
          ? `<div class="catalog-actions"><button type="button" class="btn sm catalog-open" disabled>${item.type === 'tv' ? 'Choose episode' : 'Choose language'}</button><span class="source-note">No authorized source configured</span></div>`
          : `<div class="catalog-actions catalog-watch" data-type="${item.type}" data-tmdb="${item.tmdbId}"><span class="watch-label">Where to watch…</span></div>`}
      <div class="catalog-picker" hidden></div>
    </article>`;
  }).join('');
  results.scrollTop = 0;
  results.querySelectorAll('.catalog-watch').forEach(fillWatchProviders);
}

const WATCH_FALLBACK = ['netflix', 'prime', 'max', 'disney', 'hulu'];
function watchSvcButton(id, name) {
  return `<button type="button" class="btn sm watch-svc" data-svc="${esc(id)}" style="--svc:${SERVICE_COLORS[id] || 'var(--accent)'}">${esc(name || SERVICE_NAMES[id] || id)}</button>`;
}
async function fillWatchProviders(el) {
  try {
    const list = await catalogRequest('providers', { mediaType: el.dataset.type, tmdbId: el.dataset.tmdb });
    const services = (Array.isArray(list) ? list : []).filter(s => SERVICE_SEARCH[s.id]);
    if (services.length) el.innerHTML = `<span class="watch-label">Watch together on</span>` + services.map(s => watchSvcButton(s.id, s.name)).join('');
    else el.innerHTML = `<span class="watch-label">Not on a supported service here — open one to look:</span>` + WATCH_FALLBACK.map(id => watchSvcButton(id)).join('');
  } catch {
    el.innerHTML = `<span class="watch-label">Couldn\u2019t load services — open one to look:</span>` + WATCH_FALLBACK.map(id => watchSvcButton(id)).join('');
  }
}

async function catalogSearch(query) {
  const q = String(query || '').trim();
  if (!q) return;
  const seq = ++catalogSeq;
  $('#catalogStatus').textContent = `Searching for "${q}"…`;
  $('#catalogResults').innerHTML = '';
  try {
    const list = await catalogRequest('search', { q });
    if (seq === catalogSeq) showCatalogResults(q, list || []);
  } catch (error) { if (seq === catalogSeq) $('#catalogStatus').textContent = error.message; }
}

function moviePicker(card, item) {
  const picker = card.querySelector('.catalog-picker');
  picker.hidden = false;
  picker.innerHTML = `<select class="catalog-language" aria-label="Audio language">${languageOptions(item.languages)}</select><button type="button" class="btn primary catalog-play">Play in room</button>`;
  card._catalogRef = item.type === 'free' ? { type: 'free', freeId: item.freeId } : { type: 'movie', tmdbId: item.tmdbId };
}

async function loadCatalogSeason(card, item, seasonNumber) {
  const picker = card.querySelector('.catalog-picker');
  const status = picker.querySelector('.catalog-picker-status');
  status.textContent = 'Loading episodes…';
  try {
    const season = await catalogRequest('season', { tmdbId: item.tmdbId, season: seasonNumber });
    const episodeSelect = picker.querySelector('.catalog-episode');
    episodeSelect.innerHTML = season.episodes.map(episode => `<option value="${episode.number}" data-languages="${esc(JSON.stringify(episode.languages || []))}">E${episode.number} · ${esc(episode.name)}</option>`).join('');
    const firstReady = [...episodeSelect.options].find(option => JSON.parse(option.dataset.languages || '[]').length) || episodeSelect.options[0];
    if (firstReady) episodeSelect.value = firstReady.value;
    updateCatalogEpisode(card, item);
    status.textContent = '';
  } catch (error) { status.textContent = error.message; }
}

function updateCatalogEpisode(card, item) {
  const picker = card.querySelector('.catalog-picker');
  const season = Number(picker.querySelector('.catalog-season').value);
  const episodeSelect = picker.querySelector('.catalog-episode');
  const option = episodeSelect.selectedOptions[0];
  const episode = Number(episodeSelect.value);
  const languages = option ? JSON.parse(option.dataset.languages || '[]') : [];
  const language = picker.querySelector('.catalog-language');
  language.innerHTML = languageOptions(languages);
  language.disabled = !languages.length;
  picker.querySelector('.catalog-play').disabled = !languages.length;
  picker.querySelector('.catalog-picker-status').textContent = languages.length ? '' : 'No authorized source is configured for this episode.';
  card._catalogRef = { type: 'tv', tmdbId: item.tmdbId, season, episode };
}

async function tvPicker(card, item) {
  const picker = card.querySelector('.catalog-picker');
  picker.hidden = false;
  picker.innerHTML = '<p class="catalog-picker-status fine">Loading seasons…</p>';
  try {
    const details = await catalogRequest('details', { mediaType: 'tv', tmdbId: item.tmdbId });
    const seasons = details.seasons || [];
    if (!seasons.length) throw new Error('No regular seasons were found.');
    picker.innerHTML = `<select class="catalog-season" aria-label="Season">${seasons.map(season => `<option value="${season.number}">${esc(season.name)}${season.available ? ' · ready' : ''}</option>`).join('')}</select>
      <select class="catalog-episode" aria-label="Episode"></select><select class="catalog-language" aria-label="Audio language"></select><button type="button" class="btn primary catalog-play" disabled>Play in room</button><p class="catalog-picker-status fine"></p>`;
    const firstReady = seasons.find(season => season.available) || seasons[0];
    picker.querySelector('.catalog-season').value = String(firstReady.number);
    await loadCatalogSeason(card, item, firstReady.number);
  } catch (error) { picker.innerHTML = `<p class="catalog-picker-status fine">${esc(error.message)}</p>`; }
}

$('#catalogForm').addEventListener('submit', event => { event.preventDefault(); catalogSearch($('#catalogQuery').value); });
$('#catalogResults').addEventListener('change', event => {
  const card = event.target.closest('.catalog-card');
  const item = card && catalogItems.get(card.dataset.catalogKey);
  if (!item) return;
  if (event.target.matches('.catalog-season')) loadCatalogSeason(card, item, Number(event.target.value));
  if (event.target.matches('.catalog-episode')) updateCatalogEpisode(card, item);
});
$('#catalogResults').addEventListener('click', event => {
  const card = event.target.closest('.catalog-card');
  const item = card && catalogItems.get(card.dataset.catalogKey);
  if (!item) return;
  if (event.target.closest('.catalog-open')) {
    if (item.type === 'tv') tvPicker(card, item); else moviePicker(card, item);
    return;
  }
  const svcBtn = event.target.closest('.watch-svc');
  if (svcBtn) {
    launchCatalogService(svcBtn.dataset.svc, item);
    return;
  }
  if (!event.target.closest('.catalog-play') || !card._catalogRef) return;
  const language = card.querySelector('.catalog-language').value;
  if (!language) return;
  const label = card.querySelector('.catalog-language').selectedOptions[0]?.textContent || language;
  showTuneIn(`${item.title} · ${label}`);
  conn.send({ type: 'select-catalog', ref: card._catalogRef, language, title: item.title });
});

function returnHome() {
  if (!conn) return;
  saveAnimeProgress(undefined, true);
  savePlaybackProgress(undefined, true);
  pendingCatalogService = null;
  hideTuneIn(true);
  closeYouTube();
  closePops();
  conn.send({ type: 'select-movie', id: null });
}
$('#homeBtn').addEventListener('click', returnHome);

export { closeYouTube, finishCatalogServiceLaunch, onCatalogResponse, onYouTubeEnded, onYtResults, openYouTube, refreshShelf };
