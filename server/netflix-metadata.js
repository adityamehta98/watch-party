'use strict';

const SITE = 'https://www.netflix.com';
const titlePath = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?title\/(\d{1,12})\/?$/i;
const label = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140) : '';
const cache = new Map();

function posterUrl(value) {
  if (typeof value !== 'string' || value.length > 1200) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !/(^|\.)(nflxso\.net|nflximg\.net)$/.test(url.hostname) ||
        url.port || url.username || url.password || !url.pathname.startsWith('/dnm/api/')) return '';
    const revision = url.searchParams.get('r');
    return url.origin + url.pathname + (/^[a-f0-9]{1,12}$/i.test(revision || '') ? `?r=${revision}` : '');
  } catch { return ''; }
}

function cleanNetflixMetadata(value) {
  const title = label(value?.title);
  if (!title) return null;
  const episode = Number.isSafeInteger(value.episode) && value.episode > 0 && value.episode < 10000 ? value.episode : null;
  return { title, poster: posterUrl(value.poster), episode, episodeTitle: episode ? label(value.episodeTitle) : '',
    ...(/^\d{1,12}$/.test(String(value.seriesId || '')) && episode ? { seriesId: String(value.seriesId) } : {}),
    ...(episode && typeof value.finalEpisode === 'boolean' ? { finalEpisode: value.finalEpisode } : {}),
    ...(Number.isFinite(value.checkedAt) && value.checkedAt > 0 ? { checkedAt: value.checkedAt } : {}),
    season: episode && Number.isSafeInteger(value.season) && value.season > 0 && value.season < 1000 ? value.season : null };
}

function parseNetflixTitle(html, titleId, watchId, collectEpisode = () => {}) {
  let schema = null;
  for (const [, json] of html.matchAll(/<script\b[^>]*\btype=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const value = JSON.parse(json), url = new URL(value.url);
      if (url.origin === SITE && titlePath.exec(url.pathname)?.[1] === titleId && ['TVSeries', 'Movie'].includes(value['@type'])) { schema = value; break; }
    } catch { /* Other structured data is unrelated. */ }
  }
  if (!schema) return null;
  if (schema['@type'] === 'Movie' && titleId === watchId) return cleanNetflixMetadata({ title: schema.name, poster: schema.image });
  if (schema['@type'] !== 'TVSeries') return null;

  // Netflix includes the episode IDs in its public page data. Parse it as data,
  // never execute the script or choose an episode based on a title match.
  const start = /\bnetflix\.reactContext\s*=\s*/.exec(html);
  const end = start && html.indexOf('</script>', start.index + start[0].length);
  if (!start || end < 0) return null;
  let models;
  try {
    const raw = html.slice(start.index + start[0].length, end).trim().replace(/;$/, '');
    models = JSON.parse(raw.replace(/\\(?:\\|x[\da-f]{2}|.)/gi, token => token[1] === 'x' ? '\\u00' + token.slice(2) : token)).models;
  } catch { return null; }
  for (const data of Object.values(models?.graphqlClcs?.data || {})) {
    const nodes = data?.clcsHookV2?.result?.screen?.componentTree?.nodes;
    if (!Array.isArray(nodes)) continue;
    // Netflix varies the component data field across page renditions. Search
    // the bounded JSON tree for the exact series ID instead of a UI field name.
    const pending = nodes.map(value => ({ value, depth: 0 }));
    while (pending.length) {
      const { value: show, depth } = pending.pop();
      if (!show || typeof show !== 'object' || depth > 32) continue;
      if (show.__typename !== 'Show' || String(show.videoId) !== titleId) {
        for (const value of Object.values(show)) if (value && typeof value === 'object') pending.push({ value, depth: depth + 1 });
        continue;
      }
      const seasons = show?.seasons?.edges;
      if (!Array.isArray(seasons)) continue;
      let matched = null;
      const inventory = [];
      let complete = show.seasons.pageInfo?.hasNextPage === false && show.seasons.totalCount === seasons.length && seasons.length > 0;
      const seasonNumbers = new Set();
      for (const edge of seasons) {
        const season = edge?.node;
        const episodes = season?.episodes?.edges;
        if (!Array.isArray(episodes)) { complete = false; continue; }
        const seasonNumber = /^(?:Season\s+)?(\d+)$/i.exec(season.numberLabelV2 || season.shortTitle || season.title || '');
        const number = seasonNumber ? Number(seasonNumber[1]) : 0;
        if (!number || seasonNumbers.has(number) || !episodes.length || season.episodes.pageInfo?.hasNextPage !== false) complete = false;
        seasonNumbers.add(number);
        for (const edge of episodes) {
          const episode = edge?.node;
          if (!episode || !/^\d{1,12}$/.test(String(episode.videoId))) { complete = false; continue; }
          const metadata = cleanNetflixMetadata({ title: show.title || schema.name, seriesId: titleId, episode: episode.number, episodeTitle: episode.title,
            season: seasonNumber ? Number(seasonNumber[1]) : null,
            poster: posterUrl(show.boxshot300?.url) || posterUrl(schema.image) || posterUrl(episode.merchStill300?.url) });
          if (!metadata?.episode) { complete = false; continue; }
          inventory.push({ id: String(episode.videoId), metadata });
          if (String(episode.videoId) === watchId) matched = metadata;
        }
      }
      const last = complete ? [...inventory].sort((a, b) => b.metadata.season - a.metadata.season || b.metadata.episode - a.metadata.episode)[0] : null;
      for (const { id, metadata } of inventory) {
        if (last) metadata.finalEpisode = id === last.id;
        collectEpisode(id, metadata);
      }
      if (matched) return matched;
    }
  }
  return null;
}

async function fetchNetflixMetadata(watchUrl, { request = fetch } = {}) {
  const watch = new URL(watchUrl);
  const watchId = /^\/watch\/(\d{1,12})$/.exec(watch.pathname)?.[1];
  if (![SITE, 'https://netflix.com'].includes(watch.origin) || watch.username || watch.password || !watchId) return null;
  const saved = request === fetch && cache.get(watchId);
  if (saved && saved.until > Date.now()) return saved.value;
  let url = new URL(`/title/${watchId}`, SITE);
  const signal = AbortSignal.timeout(12000);
  for (let hop = 0; hop < 4; hop++) {
    const response = await request(url.href, { redirect: 'manual', signal, headers: { accept: 'text/html', 'accept-language': 'en' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const target = new URL(response.headers.get('location') || '/', url);
      if (target.origin !== SITE || target.username || target.password || !titlePath.test(target.pathname)) return null;
      url = new URL(target.pathname, SITE);
      continue;
    }
    const maxBytes = 6 * 1024 * 1024;
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel(); return null;
    }
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) return null;
      chunks.push(Buffer.from(chunk));
    }
    const episodes = [];
    const metadata = parseNetflixTitle(Buffer.concat(chunks).toString('utf8'), titlePath.exec(url.pathname)[1], watchId,
      (id, value) => episodes.push({ id, value }));
    if (metadata) for (const value of [metadata, ...episodes.map(episode => episode.value)]) value.checkedAt = Date.now();
    if (request === fetch && metadata) {
      for (const { id, value } of [{ id: watchId, value: metadata }, ...episodes]) {
        cache.set(id, { value, until: Date.now() + 6 * 3600e3 });
        if (cache.size > 500) cache.delete(cache.keys().next().value);
      }
    }
    return metadata;
  }
  return null;
}

module.exports = { cleanNetflixMetadata, fetchNetflixMetadata, parseNetflixTitle };
