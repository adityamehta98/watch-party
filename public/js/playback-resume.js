const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = value => {
  const seconds = Math.floor(Math.max(0, Number(value) || 0));
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds / 60) % 60;
  return `${hours ? `${hours}:${String(minutes).padStart(2, '0')}` : minutes}:${String(seconds % 60).padStart(2, '0')}`;
};
export function playbackResumeEntries(entries) {
  const groups = new Map();
  for (const entry of [...entries].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const series = entry.service === 'netflix' && entry.netflix?.episode
      ? `netflix:${entry.netflix.seriesId || entry.netflix.title.normalize('NFKC').toLowerCase()}`
      : entry.kind === 'catalog' && entry.catalogRef?.type === 'tv' ? `catalog:${entry.catalogRef.tmdbId}` : `asset:${entry.id}`;
    if (!groups.has(series)) groups.set(series, entry);
  }
  // Filter after grouping: hiding/completing the latest episode must not expose
  // an older episode of that series as a new Continue watching card.
  return [...groups.values()].filter(entry => {
    const seriesFinished = entry.service === 'netflix' && entry.netflix?.finalEpisode === true && entry.position > 0 &&
      entry.duration - entry.position <= Math.min(300, entry.duration / 2);
    return !entry.hidden && !seriesFinished && entry.position < entry.duration - Math.min(30, entry.duration * .02);
  });
}
export function playbackResumeCard(entry, canDismiss) {
  const percent = Math.max(0, Math.min(100, entry.position / entry.duration * 100));
  const stamp = `${time(entry.position)} / ${time(entry.duration)}`;
  const netflix = entry.service === 'netflix' ? entry.netflix : null;
  const poster = netflix?.poster || entry.poster || '';
  const episode = netflix?.episode ? `${netflix.season > 1 ? `S${netflix.season} ` : ''}Ep ${netflix.episode}${netflix.episodeTitle ? ` — ${netflix.episodeTitle}` : ''}` : '';
  const title = netflix?.title || entry.title;
  const accessibleTitle = episode ? `${title} · ${episode}` : title;
  return `<article class="anime-resume-card playback-resume-card">
    <button type="button" class="anime-resume-open" data-playback-play="${esc(entry.id)}" aria-label="${esc(accessibleTitle)} · Resume at ${esc(stamp)}">
      <span class="anime-resume-art"><span class="anime-resume-placeholder" aria-hidden="true"><svg><use href="#i-film"/></svg></span>
        ${poster ? `<img class="playback-resume-poster" src="${esc(poster)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''}
        <span class="playback-resume-title${poster ? ' with-poster' : ''}"><small>${esc(entry.serviceName || (entry.kind === 'file' ? 'Your library' : 'Movies & TV'))}</small><strong>${esc(title)}</strong>${episode ? `<span class="playback-resume-episode">${esc(episode)}</span>` : ''}<small>${esc(stamp)}</small></span>
      </span>
      <span class="anime-resume-progress" role="progressbar" aria-label="Playback progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent.toFixed(1)}" aria-valuetext="${esc(stamp)}"><span style="width:${percent.toFixed(3)}%"></span></span>
    </button>
    ${canDismiss ? `<button type="button" class="anime-resume-dismiss" data-playback-dismiss="${esc(entry.id)}" aria-label="Remove ${esc(accessibleTitle)} from Continue watching"><svg><use href="#i-x"/></svg></button>` : ''}
  </article>`;
}
