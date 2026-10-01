'use strict';
// YouTube search without an account or an API key: this PC asks youtube.com the same way a signed-out
// browser does, and reads the results out of the page. Videos then play in the embedded YouTube
// player inside the party, for everyone (phones and tablets too, no extension needed).
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
  const vr = node.videoRenderer;
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
  const lv = node.lockupViewModel;
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

async function search(query, fetchImpl = fetch) {
  const q = String(query || '').trim().slice(0, 150);
  if (!q) return [];
  const hit = cache.get(q.toLowerCase());
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.results;
  // sp=EgIQAQ%3D%3D: videos only (no channels or playlists)
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIQAQ%253D%253D&hl=en&gl=US`;
  const r = await fetchImpl(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1; SOCS=CAI' },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`YouTube answered ${r.status}`);
  const results = parsePage(await r.text());
  cache.set(q.toLowerCase(), { at: Date.now(), results });
  if (cache.size > 100) cache.delete(cache.keys().next().value);
  return results;
}

module.exports = { search, parsePage };
