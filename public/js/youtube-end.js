const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function youtubeEndCards(videos, currentId) {
  return videos.filter(v => !v.playlist && /^[A-Za-z0-9_-]{11}$/.test(v.id || '') && v.id !== currentId).slice(0, 6).map(v =>
    `<button type="button" class="yt-card" data-yid="${esc(v.id)}" title="${esc(v.title)}"><div class="th"><img src="https://i.ytimg.com/vi/${v.id}/hqdefault.jpg" alt="" loading="lazy" referrerpolicy="no-referrer">${v.duration ? `<span class="dur">${esc(v.duration)}</span>` : ''}</div><div class="t">${esc(v.title)}</div><div class="m">${esc(v.channel || '')}</div></button>`).join('');
}
