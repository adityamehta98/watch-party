const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = value => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
export function playbackResumeCard(entry, canDismiss) {
  const percent = Math.max(0, Math.min(100, entry.position / entry.duration * 100));
  const stamp = `${time(entry.position)} / ${time(entry.duration)}`;
  return `<article class="anime-resume-card playback-resume-card">
    <button type="button" class="anime-resume-open" data-playback-play="${esc(entry.id)}" aria-label="${esc(entry.title)} · Resume at ${esc(stamp)}">
      <span class="anime-resume-art"><span class="anime-resume-placeholder" aria-hidden="true"><svg><use href="#i-film"/></svg></span>
        <span class="playback-resume-title"><small>${esc(entry.serviceName || (entry.kind === 'file' ? 'Your library' : 'Movies & TV'))}</small><strong>${esc(entry.title)}</strong><small>${esc(stamp)}</small></span>
      </span>
      <span class="anime-resume-progress" role="progressbar" aria-label="Playback progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent.toFixed(1)}" aria-valuetext="${esc(stamp)}"><span style="width:${percent.toFixed(3)}%"></span></span>
    </button>
    ${canDismiss ? `<button type="button" class="anime-resume-dismiss" data-playback-dismiss="${esc(entry.id)}" aria-label="Remove ${esc(entry.title)} from Continue watching"><svg><use href="#i-x"/></svg></button>` : ''}
  </article>`;
}
