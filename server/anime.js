'use strict';
// Anime search + playable embed, with no browser extension (plays in the page on iPad too).
//
// Discovery uses AniList's public GraphQL API (stable, documented). Playback uses MegaPlay's
// documented embed (https://megaplay.buzz/api), which hosts the former HiAnime library. The embed
// decrypts and plays itself inside an <iframe>. MegaPlay reports progress to the parent page with
// postMessage; the browser must send the embedding site's origin as the iframe referrer.
//
// A given episode can be missing on one mapping but present on another, so the player gets both ID
// systems. Never silently switch languages: if the viewer selected Dub, a Sub fallback is wrong.

const HOST = 'https://megaplay.buzz';

const mkUrl = (kind, id, ep, lang) => {
  const i = Math.trunc(Number(id)), n = Math.trunc(Number(ep));
  const l = lang === 'dub' ? 'dub' : 'sub';
  return i > 0 && n > 0 ? `${HOST}/stream/${kind}/${i}/${n}/${l}` : null;
};

// Ordered candidates the player tries until one plays. anilistId is required; malId is optional.
function embedSources(anilistId, malId, ep, lang) {
  const want = lang === 'dub' ? 'dub' : 'sub';
  return [
    mkUrl('ani', anilistId, ep, want),
    mkUrl('mal', malId, ep, want),
  ].filter(Boolean);
}
async function search(q) {
  const query = String(q || '').trim();
  if (!query) return [];
  const body = {
    query: `query($s:String){Page(perPage:12){media(search:$s,type:ANIME,sort:SEARCH_MATCH){id idMal episodes format seasonYear title{romaji english} coverImage{medium}}}}`,
    variables: { s: query },
  };
  const r = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`AniList said ${r.status}`);
  const j = await r.json();
  const list = (j && j.data && j.data.Page && j.data.Page.media) || [];
  return list.map(m => ({
    id: m.id,
    mal: m.idMal || 0,
    title: (m.title && (m.title.english || m.title.romaji)) || `#${m.id}`,
    episodes: Number(m.episodes) || 0,
    year: m.seasonYear || null,
    format: m.format || '',
    poster: (m.coverImage && m.coverImage.medium) || '',
  })).filter(m => m.id > 0);
}

module.exports = { search, embedSources };
