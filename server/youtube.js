'use strict';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const cache = new Map(); // query -> { at, results }

function text(t) {
  if (!t) return '';
  if (typeof t === 'string') return t;
  if (t.simpleText) return t.simpleText;
  if (t.content) return t.content;
  if (Array.isArray(t.runs)) return t.runs.map(r => r.text || '').join('');
  return '';
}

// Walk the page data and pick out every video, whichever layout YouTube uses this month.
function collect(node, out, seen, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 40 || out.length >= 40) return;
  if (Array.isArray(node)) { for (const x of node) collect(x, out, seen, depth + 1); return; }
  const vr = node.videoRenderer || node.compactVideoRenderer || node.playlistVideoRenderer;
  if (vr && vr.videoId && !seen.has(vr.videoId)) {
    seen.add(vr.videoId);
    const thumbs = (vr.thumbnail && vr.thumbnail.thumbnails) || [];
    out.push({
      id: vr.videoId, title: text(vr.title), channel: text(vr.ownerText || vr.longBylineText || vr.shortBylineText),
      duration: text(vr.lengthText), views: text(vr.shortViewCountText || vr.viewCountText), when: text(vr.publishedTimeText),
      thumb: (thumbs[thumbs.length - 1] || {}).url || `https://i.ytimg.com/vi/${vr.videoId}/hqdefault.jpg`,
      live: !vr.lengthText && /live/i.test(JSON.stringify(vr.badges || vr.thumbnailOverlays || '')),
    });
  }
  const playlist = node.playlistRenderer || node.gridPlaylistRenderer;
  if (playlist && /^[A-Za-z0-9_-]{10,100}$/.test(playlist.playlistId || '') && !seen.has(playlist.playlistId)) {
    seen.add(playlist.playlistId);
    const thumb = playlist.thumbnails?.[0]?.thumbnails?.[0]?.url || '';
    out.push({ id: playlist.playlistId, playlist: true, title: text(playlist.title), channel: text(playlist.shortBylineText),
      duration: `${text(playlist.videoCount) || 'Multiple'} videos`, thumb: /^https:\/\/i\.ytimg\.com\//.test(thumb) ? thumb : '' });
  }
  const lv = node.lockupViewModel;
  if (lv && /PLAYLIST/.test(lv.contentType || '') && /^[A-Za-z0-9_-]{10,100}$/.test(lv.contentId || '') && !seen.has(lv.contentId)) {
    seen.add(lv.contentId);
    const meta = lv.metadata?.lockupMetadataViewModel || {};
    const image = lv.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel?.image?.sources?.[0]?.url;
    out.push({ id: lv.contentId, playlist: true, title: text(meta.title), channel: 'Playlist', duration: 'View playlist', thumb: /^https:\/\/i\.ytimg\.com\//.test(image || '') ? image : '' });
  }
  if (lv && lv.contentId && /VIDEO/.test(lv.contentType || '') && !seen.has(lv.contentId)) {
    seen.add(lv.contentId);
    const meta = (lv.metadata && lv.metadata.lockupMetadataViewModel) || {};
    const rows = (((meta.metadata || {}).contentMetadataViewModel || {}).metadataRows || []).map(r => (r.metadataParts || []).map(p => text(p.text)).filter(Boolean));
    const json = JSON.stringify(lv.contentImage || {});
    const dur = (/"text":"(\d+:\d{2}(?::\d{2})?)"/.exec(json) || [])[1] || '';
    out.push({
      id: lv.contentId, title: text(meta.title), channel: (rows[0] || [])[0] || '', duration: dur,
      views: (rows[1] || [])[0] || '', when: (rows[1] || [])[1] || '',
      thumb: `https://i.ytimg.com/vi/${lv.contentId}/hqdefault.jpg`, live: /LIVE/i.test(json) && !dur,
    });
  }
  for (const k of Object.keys(node)) if (k !== 'videoRenderer' && k !== 'lockupViewModel') collect(node[k], out, seen, depth + 1);
}

function parsePage(html) {
  const m = /var ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s.exec(html) || /window\["ytInitialData"\]\s*=\s*(\{.+?\});/s.exec(html);
  if (!m) throw new Error('YouTube sent a page without results');
  const data = JSON.parse(m[1]);
  const out = [];
  collect(data, out, new Set());
  return out;
}

async function search(query, fetchImpl = fetch, options = {}) {
  const q = String(query || '').trim().slice(0, 150);
  if (!q) return [];
  const mode = ['related', 'playlist', 'playlists'].includes(options.mode) ? options.mode : 'search';
  const id = String(options.id || '');
  if (mode === 'related' && !/^[A-Za-z0-9_-]{11}$/.test(id) || mode === 'playlist' && !/^[A-Za-z0-9_-]{10,100}$/.test(id)) throw new Error('Invalid YouTube selection');
  const cacheKey = `${mode}:${id}:${q.toLowerCase()}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.results;
  // sp=EgIQAQ%3D%3D: videos only (no channels or playlists)
  const url = mode === 'related' ? `https://www.youtube.com/watch?v=${id}&hl=en&gl=US` : mode === 'playlist' ? `https://www.youtube.com/playlist?list=${id}&hl=en&gl=US` :
    `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=${mode === 'playlists' ? 'EgIQAw%253D%253D' : 'EgIQAQ%253D%253D'}&hl=en&gl=US`;
  const r = await fetchImpl(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`YouTube answered ${r.status}`);
  const results = parsePage(await r.text()).filter(v => mode === 'playlists' ? v.playlist : !v.playlist && (mode !== 'related' || v.id !== id));
  cache.set(cacheKey, { at: Date.now(), results });
  if (cache.size > 100) cache.delete(cache.keys().next().value);
  return results;
}

module.exports = { search, parsePage };
