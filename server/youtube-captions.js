'use strict';

// The iframe's tracklist omits ASR tracks and translation targets. Read those
// from the same public player metadata YouTube uses for its subtitle menu.
const cache = new Map();
const language = value => /^[a-zA-Z0-9-]{2,35}$/.test(value || '');
const label = value => typeof value === 'string' ? value : value?.simpleText || value?.runs?.map(r => r.text || '').join('') || '';

function parseCaptionMetadata(html) {
  const match = /(?:var\s+ytInitialPlayerResponse|window\["ytInitialPlayerResponse"\])\s*=\s*/.exec(html);
  if (!match) throw new Error('YouTube did not return subtitle information');
  const start = match.index + match[0].length;
  let depth = 0, quoted = false, escaped = false, end = start;
  for (; end < html.length; end++) {
    const c = html[end];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { end++; break; }
  }
  const data = JSON.parse(html.slice(start, end));
  if (data.playabilityStatus?.status !== 'OK') throw new Error('YouTube subtitle information is unavailable');
  const renderer = data.captions?.playerCaptionsTracklistRenderer;
  const tracks = (renderer?.captionTracks || []).filter(t => language(t.languageCode)).map(t => ({
    languageCode: t.languageCode, displayName: label(t.name).slice(0, 100) || t.languageCode,
    kind: t.kind === 'asr' ? 'asr' : '', vssId: String(t.vssId || '').slice(0, 100), isTranslatable: t.isTranslatable === true,
  }));
  const translations = tracks.some(t => t.isTranslatable) ? (renderer?.translationLanguages || []).filter(t => language(t.languageCode)).map(t => ({
    languageCode: t.languageCode, displayName: label(t.languageName).slice(0, 100) || t.languageCode,
  })) : [];
  // Never expose signed caption URLs or the rest of the player response.
  return { tracks, translations };
}

async function captionMetadata(videoId, fetchImpl = fetch) {
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId || '')) throw new Error('Invalid YouTube video');
  const hit = cache.get(videoId);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.promise;
  const entry = { at: Date.now() };
  entry.promise = (async () => {
    const response = await fetchImpl(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`YouTube answered ${response.status}`);
    return parseCaptionMetadata(await response.text());
  })();
  cache.set(videoId, entry);
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  try { return await entry.promise; }
  catch (error) { if (cache.get(videoId) === entry) cache.delete(videoId); throw error; }
}

module.exports = { captionMetadata, parseCaptionMetadata };
