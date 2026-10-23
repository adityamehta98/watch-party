const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = value => {
  const seconds = Math.floor(Math.max(0, Number(value) || 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

export function animeResumeAction(entry) {
  const next = entry.completed && entry.episodes > entry.episode;
  return { episode: entry.episode + (next ? 1 : 0), label: next ? `Play episode ${entry.episode + 1}` : entry.completed ? `Replay episode ${entry.episode}` : `Resume episode ${entry.episode} · ${time(entry.position)}` };
}

export function animeResumeCard(entry) {
  const pick = animeResumeAction(entry);
  const duration = Number.isFinite(entry.duration) && entry.duration > 0 ? entry.duration : 0;
  const position = Math.max(0, Number(entry.position) || 0);
  const percent = duration ? Math.max(0, Math.min(100, position / duration * 100)) : 0;
  const stamp = duration ? `${time(position)} / ${time(duration)}` : `${time(position)} watched`;
  const label = `${entry.animeTitle} · ${pick.label}${!entry.completed && duration ? ` of ${time(duration)}` : ''}`;
  return `<article class="anime-resume-card">
    <button type="button" class="anime-resume-open" data-history-play="${Number(entry.anilistId)}" data-episode="${pick.episode}" aria-label="${esc(label)}">
    <span class="anime-resume-art">
      <span class="anime-resume-placeholder" aria-hidden="true"><svg><use href="#i-film"/></svg></span>
      ${entry.poster ? `<img src="${esc(entry.poster)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
      <span class="anime-resume-overlay" aria-hidden="true">
        <span class="anime-resume-play"><svg viewBox="0 0 24 24"><path d="M9 5v14l11-7z" fill="currentColor" stroke="none"/></svg></span>
        <span class="anime-resume-hover-label"><strong>${esc(entry.animeTitle)}</strong><span>${entry.completed ? esc(pick.label) : `Resume episode ${entry.episode}`}</span><small>${entry.language === 'dub' ? 'Dub' : 'Sub'} · ${entry.completed ? 'Watched' : `Stopped at ${time(position)}`}</small><small>${esc(stamp)}</small></span>
      </span>
    </span>
    <span class="anime-resume-progress" role="progressbar" aria-label="Episode ${entry.episode} progress" aria-valuemin="0" aria-valuemax="100" ${duration ? `aria-valuenow="${percent.toFixed(1)}"` : ''} aria-valuetext="${esc(stamp)}"><span style="width:${percent.toFixed(3)}%"></span></span>
    </button>
    <button type="button" class="anime-resume-dismiss" data-history-dismiss="${Number(entry.anilistId)}" aria-label="Remove ${esc(entry.animeTitle)} from Continue watching" title="Remove from Continue watching"><svg aria-hidden="true"><use href="#i-x"/></svg></button>
  </article>`;
}
