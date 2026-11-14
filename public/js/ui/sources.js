// What the <video> plays and how it looks: file and stream sources, subtitles, ambient light and battery saver.
import { buildCcMenu, renderNotice, selectSub } from './controls.js';
import { $, PLAYBACK, S, app, clientId, codecLabel, conn, esc, isNativeMovie, isTheater, key, kindOf, player, remote, setHtml, stage, store, video, ytMedia } from './core.js';
import { toast } from './social.js';
import { deliverySources, reconcileDeliverySources } from '../capabilities.js';
import { FilePlayback } from '../file-playback.js';
import { PLATFORM } from '../platform.js';
import { createPlayerMenu } from '../player-menu.js';
import { SubtitleTracks } from '../subtitles.js';
import { observeVisualPolicy, visualPolicy } from '../visuals.js';

const moreMenu = createPlayerMenu($('#playerMorePop'));

const filePlayback = new FilePlayback(video, {
  onReady: () => { clearTimeout(fileStartTimer); S.filePlaybackError = null; renderNotice(); },
  onFatal: error => {
    S.filePlaybackError = error.message;
    if (!tryNextFileSource('The streaming copy failed, so playback switched to another format.')) renderNotice();
  },
});

const subtitles = new SubtitleTracks(video, {
  preference: () => {
    const lang = store.get('wp.subLang', null), label = store.get('wp.subLabel', null);
    return lang || label ? { lang, label } : null;
  },
  onChange: () => buildCcMenu(),
  onError: sub => {
    if (S.movie?.kind === 'anime' && !sub.local) requestSubtitles(subtitleLanguage(sub));
    else toast(`${sub.label} subtitles could not be downloaded.`, {
      timeout: 10000, actions: [{ label: 'Retry subtitles', run: () => subtitles.retry() }],
    });
  },
});

function subtitleLanguage(sub) {
  const value = String(sub?.lang || sub?.label || store.get('wp.subLang', '') || store.get('wp.subLabel', '') || 'en').toLowerCase().split(/[-_]/)[0];
  return ({ english: 'en', eng: 'en', spanish: 'es', spa: 'es', japanese: 'ja', jpn: 'ja' })[value] || (/^[a-z]{2}$/.test(value) ? value : 'en');
}

function requestSubtitles(lang = subtitleLanguage(), explicit = false) {
  if (S.movie?.kind !== 'anime') return;
  if (explicit) {
    store.set('wp.subLang', lang);
    store.set('wp.subLabel', null);
    subtitles.off = false;
    subtitles.preferLocal = lang;
    const saved = S.movie.subs?.find(s => s.local && s.lang === lang);
    if (saved) { selectSub(saved.key); return; }
  }
  const status = S.movie.subtitleSearch?.[lang];
  if (status?.state === 'searching' || (status?.state === 'setup' && !S.settings?.subtitlesConfigured)) return;
  conn?.send({ type: 'find-subtitles', movieId: S.movie.id, lang });
}

function maybeFindSubtitles() {
  if (S.movie?.kind !== 'anime' || subtitles.off) return;
  const active = subtitles.sources.get(subtitles.selected);
  if (active && subtitles.status(subtitles.selected) === 'error' && !active.local) requestSubtitles(subtitleLanguage(active));
  else if (!S.movie.subs?.length && (store.get('wp.subLang', null) || store.get('wp.subLabel', null))) requestSubtitles();
}

// Visual effects are local-only: policy inputs, sampled colors and preferences never leave this browser.
const visualPrefs = { ambient: store.get('wp.ambient', true), saver: store.get('wp.saver', false) };
let visuals = visualPolicy({ forcedSaver: visualPrefs.saver });
const ambientCanvas = Object.assign(document.createElement('canvas'), { width: 12, height: 7 });
const ambientContext = ambientCanvas.getContext('2d', { willReadFrequently: true });
let ambientFrame = 0, ambientTimer = 0, ambientSampleAt = 0;

function canUseAmbient() {
  return !!(visualPrefs.ambient && visuals.ambient && S.movie && isNativeMovie(S.movie) && video.readyState >= 2 && document.visibilityState === 'visible');
}
function renderMoreControls() {
  const hls = filePlayback.hls, levels = hls?.levels || [], kind = kindOf(S.movie);
  const row = $('#playerMorePop').querySelector('[data-quality-row]');
  const current = video.videoHeight ? `${video.videoHeight}p` : 'Source quality';
  setHtml(row, levels.length && isNativeMovie(S.movie)
    ? `<label class="caption-language">Video quality<select data-quality aria-label="Video quality"><option value="-1" ${hls.autoLevelEnabled ? 'selected' : ''}>Auto</option>${levels.map((l, i) => `<option value="${i}" ${!hls.autoLevelEnabled && hls.loadLevel === i ? 'selected' : ''}>${l.height ? `${l.height}p` : `${Math.round(l.bitrate / 1000)} kbps`}</option>`).join('')}</select></label>`
    : kind === 'youtube' || kind === 'service' ? `<button type="button" data-quality-native ${kind === 'service' && !remote?.linked ? 'disabled title="Connect Watch Party Sync to this service first"' : ''}>Video quality · Player settings</button>`
      : `<div class="menu-note">Video quality: ${esc(current)}${filePlayback.source?.type === 'direct' ? ' (original)' : ''}</div>`);
  moreMenu.update({
    cam: S.cam, mic: S.mic,
    ambientPreference: visualPrefs.ambient, ambientAllowed: visuals.ambient,
    ambientReason: visuals.reasons.filter(reason => reason !== 'manual').join(', ') || (visuals.saver ? 'battery saver' : ''),
    saver: visuals.saver, manualSaver: visualPrefs.saver,
    saverReason: visuals.reasons.filter(reason => ['data saver', 'low battery'].includes(reason)).join(', '),
    canPip: 'documentPictureInPicture' in window || (isTheater && kindOf(S.movie) === 'service'),
    pip: !!S.pipWin || S.theaterPip,
  });
}
$('#playerMorePop').addEventListener('change', e => {
  if (!e.target.matches('[data-quality]') || !isNativeMovie(S.movie) || !filePlayback.hls) return;
  const level = Number(e.target.value);
  if (Number.isInteger(level) && level >= -1 && level < filePlayback.hls.levels.length) filePlayback.hls.nextLevel = level;
});
$('#playerMorePop').addEventListener('click', e => {
  if (!e.target.closest('[data-quality-native]')) return;
  if (S.movie?.kind === 'youtube') {
    stage.classList.add('youtube-settings'); ytMedia.setNativeControls(true);
  } else if (S.movie?.kind === 'service') remote.post({ type: 'quality-settings' });
  $('#playerMorePop').hidden = true;
});
$('#qualityBtn').addEventListener('click', e => {
  e.stopPropagation(); renderMoreControls();
  const native = $('#playerMorePop').querySelector('[data-quality-native]');
  if (native) native.click(); else $('#playerMoreBtn').click();
});
$('#ytSettingsClose').addEventListener('click', () => {
  stage.classList.remove('youtube-settings'); ytMedia.setNativeControls(false);
});
function renderVisualControls() {
  const ambient = $('#ambientBtn'), eco = $('#ecoBtn');
  const active = visualPrefs.ambient && visuals.ambient;
  ambient.classList.toggle('on', active);
  ambient.setAttribute('aria-pressed', String(active));
  ambient.title = active ? 'Ambient theater lighting is on' : `Ambient theater lighting is off${visuals.reasons.length ? ` (${visuals.reasons.join(', ')})` : ''}`;
  eco.classList.toggle('on', visuals.saver);
  eco.setAttribute('aria-pressed', String(visualPrefs.saver));
  eco.title = visuals.saver ? `Battery saver is on${visuals.reasons.length ? ` (${visuals.reasons.join(', ')})` : ''}` : 'Turn on battery saver';
  renderMoreControls();
  app.classList.toggle('motion-off', !visuals.motion);
}
function stopAmbientSampling() {
  if (ambientFrame) video.cancelVideoFrameCallback?.(ambientFrame);
  clearTimeout(ambientTimer);
  ambientFrame = ambientTimer = 0;
}
function sampleAmbient(now = performance.now()) {
  ambientFrame = ambientTimer = 0;
  if (!canUseAmbient()) return syncAmbient();
  if (now - ambientSampleAt >= 650 && ambientContext) {
    ambientSampleAt = now;
    try {
      ambientContext.drawImage(video, 0, 0, ambientCanvas.width, ambientCanvas.height);
      const pixels = ambientContext.getImageData(0, 0, ambientCanvas.width, ambientCanvas.height).data;
      let r = 0, g = 0, b = 0, weight = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const w = Math.max(0.15, (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 765);
        r += pixels[i] * w; g += pixels[i + 1] * w; b += pixels[i + 2] * w; weight += w;
      }
      stage.style.setProperty('--ambient-rgb', `${Math.round(r / weight)},${Math.round(g / weight)},${Math.round(b / weight)}`);
    } catch { stopAmbientSampling(); return; }
  }
  scheduleAmbientSample();
}
function scheduleAmbientSample() {
  if (!canUseAmbient() || video.paused || ambientFrame || ambientTimer) return;
  if (video.requestVideoFrameCallback) ambientFrame = video.requestVideoFrameCallback(sampleAmbient);
  else ambientTimer = setTimeout(sampleAmbient, 700);
}
function syncAmbient() {
  const available = canUseAmbient();
  $('#ambientLight').classList.toggle('on', available);
  if (available) scheduleAmbientSample(); else stopAmbientSampling();
  renderVisualControls();
}
function applyVisualPolicy(next) { visuals = next; syncAmbient(); }

const visualWatcher = observeVisualPolicy(applyVisualPolicy, () => visualPrefs.saver);

$('#ambientBtn').addEventListener('click', () => {
  visualPrefs.ambient = !visualPrefs.ambient;
  store.set('wp.ambient', visualPrefs.ambient);
  syncAmbient();
  if (!visualPrefs.ambient) toast('Ambient theater lighting off — the stage keeps a plain background.', { timeout: 3500 });
  else if (visuals.ambient) toast('Ambient theater lighting on — the stage glows with the dominant color of the scene.', { timeout: 3500 });
  else toast(`Ambient theater lighting is paused automatically (${visuals.reasons.join(', ')}). It will resume once that clears.`, { timeout: 4500 });
});
$('#ecoBtn').addEventListener('click', () => {
  visualPrefs.saver = !visualPrefs.saver;
  store.set('wp.saver', visualPrefs.saver);
  visualWatcher.refresh();
  if (visuals.saver) {
    const auto = visuals.reasons.filter(r => r !== 'manual');
    const why = auto.length ? ` (also forced by: ${auto.join(', ')})` : '';
    toast(`Battery saver on${why} — ambient halo paused and UI animations frozen to save power.`, { timeout: 4500 });
  } else {
    toast('Battery saver off — animations and ambient halo run at full quality.', { timeout: 3500 });
  }
});
for (const event of ['play', 'pause', 'loadeddata', 'emptied']) video.addEventListener(event, syncAmbient);
document.addEventListener('visibilitychange', syncAmbient);

let fileStartTimer = null;
function openFileSource(source) {
  S.filePlaybackError = null;
  filePlayback.open(source, () => S.state?.movieId === S.movie?.id ? player.expected() : 0).catch(error => {
    S.filePlaybackError = error.message;
    if (!tryNextFileSource('That format was unavailable, so playback switched to another one.')) renderNotice();
  });
}

function tryNextFileSource(reason) {
  clearTimeout(fileStartTimer);
  const next = S.fileSources?.[S.fileSourceIndex + 1];
  if (!next) return false;
  S.fileSourceIndex++;
  openFileSource(next);
  toast(reason || 'Trying the Safari-optimized stream…', { timeout: 5000 });
  return true;
}

function movieSources(movie) {
  return deliverySources(movie, PLAYBACK, key, clientId, { bufferMode: store.get('wp.animeBufferMode', 'auto') });
}
const animeBufferMode = $('#animeBufferMode');
$('#animeBufferPrefs').hidden = !PLATFORM.appleMobile || !PLAYBACK.mse;
animeBufferMode.value = store.get('wp.animeBufferMode', 'auto') === 'extended' ? 'extended' : 'auto';
animeBufferMode.addEventListener('change', () => {
  store.set('wp.animeBufferMode', animeBufferMode.value);
  if (S.movie?.kind !== 'anime') return;
  clearTimeout(fileStartTimer);
  S.fileSources = movieSources(S.movie);
  S.fileSourceIndex = 0;
  if (S.fileSources[0]) openFileSource(S.fileSources[0]);
  watchFileStart();
});

function watchFileStart() {
  clearTimeout(fileStartTimer);
  if ((S.fileSources?.length || 0) < 2) return;
  fileStartTimer = setTimeout(() => {
    if (isNativeMovie(S.movie) && video.readyState < 2) tryNextFileSource();
  }, 20000);
}

function addSubtitleTracks(movie) {
  if (movie) subtitles.add(movie, key);
  maybeFindSubtitles();
}

function refreshFileSources(movie) {
  const next = movieSources(movie);
  const { sources, activate } = reconcileDeliverySources(next, filePlayback.source, !!(S.filePlaybackError || video.error));
  S.fileSources = sources;
  S.fileSourceIndex = 0;
  if (activate) openFileSource(activate);
  else if (!sources.length && filePlayback.source) {
    filePlayback.close();
    S.filePlaybackError = 'This movie no longer has a playable source.';
  }
  watchFileStart();
}

let codecWarning = null;
function checkCodecSupport(movie) {
  codecWarning = null;
  const probes = { hevc: 'video/mp4; codecs="hvc1.2.4.L150.B0"', av1: 'video/mp4; codecs="av01.0.08M.10"', h264: 'video/mp4; codecs="avc1.640028"' };
  const t = probes[movie.codec];
  if (t && !video.canPlayType(t)) {
    codecWarning = movie.codec === 'hevc'
      ? 'This browser can\'t play this video format. Try Chrome or Edge on a Windows or Mac computer, or Safari. If it still fails, ask the host to open Options and pick a lower picture quality.'
      : `This browser can't play ${codecLabel(movie.codec)} video.`;
  }
}

export { addSubtitleTracks, checkCodecSupport, codecWarning, filePlayback, fileStartTimer, maybeFindSubtitles, movieSources, openFileSource, refreshFileSources, renderMoreControls, requestSubtitles, subtitleLanguage, subtitles, syncAmbient, tryNextFileSource, visuals, watchFileStart };
