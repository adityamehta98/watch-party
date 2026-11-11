'use strict';

const SITE = 'https://www.netflix.com';
const titlePath = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?title\/(\d{1,12})\/?$/i;
const label = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140) : '';

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
    season: episode && Number.isSafeInteger(value.season) && value.season > 0 && value.season < 1000 ? value.season : null };
}

function parseNetflixTitle(html, titleId, watchId) {
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
    for (const node of nodes) {
      const show = Array.isArray(node?.data?.videos) && node.data.videos.find(video => video?.__typename === 'Show' && String(video.videoId) === titleId);
      const seasons = show?.seasons?.edges;
      if (!Array.isArray(seasons)) continue;
      for (const edge of seasons) {
        const season = edge?.node;
        const episodes = season?.episodes?.edges;
        if (!Array.isArray(episodes)) continue;
        const episode = episodes.find(edge => String(edge?.node?.videoId) === watchId)?.node;
        if (!episode) continue;
        const seasonNumber = /^(?:Season\s+)?(\d+)$/i.exec(season.numberLabelV2 || season.shortTitle || season.title || '');
        return cleanNetflixMetadata({ title: show.title || schema.name, episode: episode.number, episodeTitle: episode.title,
          season: seasonNumber ? Number(seasonNumber[1]) : null,
          poster: posterUrl(show.boxshot300?.url) || posterUrl(schema.image) || posterUrl(episode.merchStill300?.url) });
      }
    }
  }
  return null;
}

async function fetchNetflixMetadata(watchUrl, { request = fetch } = {}) {
  const watch = new URL(watchUrl);
  const watchId = /^\/watch\/(\d{1,12})$/.exec(watch.pathname)?.[1];
  if (![SITE, 'https://netflix.com'].includes(watch.origin) || watch.username || watch.password || !watchId) return null;
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
    return parseNetflixTitle(Buffer.concat(chunks).toString('utf8'), titlePath.exec(url.pathname)[1], watchId);
  }
  return null;
}

module.exports = { cleanNetflixMetadata, fetchNetflixMetadata, parseNetflixTitle };
