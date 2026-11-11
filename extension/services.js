// Which streaming service a page belongs to (shared by the extension's scripts).
// This file is injected again when the background worker reconnects. Keep its shared bindings
// redeclarable so a second injection cannot abort the player-sync script that follows it.
var WP_SERVICES = [
  ['youtube', ['youtube.com', 'youtu.be']], ['netflix', ['netflix.com']], ['prime', ['primevideo.com', 'amazon.com']],
  ['hulu', ['hulu.com']], ['peacock', ['peacocktv.com']], ['crunchyroll', ['crunchyroll.com']],
  ['paramount', ['paramountplus.com']], ['max', ['max.com', 'hbomax.com']], ['disney', ['disneyplus.com']],
  ['appletv', ['tv.apple.com']],
];
function wpServiceOf(hostname) {
  const h = String(hostname || '').toLowerCase();
  for (const [id, hosts] of WP_SERVICES) if (hosts.some(x => h === x || h.endsWith('.' + x))) return id;
  return null;
}
if (typeof self !== 'undefined') self.wpServiceOf = wpServiceOf;
// the sites (and their sign-in pages) the "watch here" window may show inside itself
var WP_SERVICE_DOMAINS = ['netflix.com', 'primevideo.com', 'amazon.com', 'hulu.com', 'peacocktv.com', 'crunchyroll.com',
  'paramountplus.com', 'max.com', 'hbomax.com', 'disneyplus.com', 'apple.com'];
if (typeof self !== 'undefined') self.WP_SERVICE_DOMAINS = WP_SERVICE_DOMAINS;

// The "same title" test. Streaming sites add tracking bits to their links (?trackId=…, /ref=…) and
// rewrite them while you watch, so compare a trimmed version, or the room would think every little
// change is a new show and keep reloading everyone's player (and their sign-in pages).
function wpCanonicalUrl(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch { return ''; }
  const svc = wpServiceOf(u.hostname);
  if (!svc) {
    // any other website (the host's "custom site"): the page itself, query included (?ep=3 matters there)
    if (!/^https?:$/.test(u.protocol)) return '';
    return `https://${u.hostname.toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  }
  u.hash = '';
  if (svc === 'youtube') { const v = u.searchParams.get('v'); u.search = v ? `?v=${v}` : ''; }
  else u.search = '';
  let p = u.pathname.replace(/\/ref=[^/]*$/, '').replace(/\/+$/, '');
  if (svc === 'netflix') { const m = /\/watch\/(\d+)/.exec(p); if (m) p = `/watch/${m[1]}`; }
  return `https://${u.hostname.toLowerCase()}${p}${u.search}`;
}
if (typeof self !== 'undefined') self.wpCanonicalUrl = wpCanonicalUrl;

// Playback reports leave the service tab. Never forward sign-in redirects, URL credentials,
// fragments, or service tracking parameters to the party. Custom sites may identify episodes in
// their query string, so retain those parameters except common authentication credentials.
function wpSharedPageUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    if (!/^https?:$/.test(u.protocol)) return '';
    u.username = ''; u.password = ''; u.hash = '';
    const service = wpServiceOf(u.hostname);
    if (service) {
      const video = service === 'youtube' ? u.searchParams.get('v') : '';
      u.search = '';
      if (video) u.searchParams.set('v', video);
    } else {
      for (const key of [...u.searchParams.keys()]) {
        if (/^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|auth|authorization|code|password|passwd|secret|api[_-]?key|session(?:id)?)$/i.test(key)) u.searchParams.delete(key);
      }
    }
    return u.href;
  } catch { return ''; }
}
if (typeof self !== 'undefined') self.wpSharedPageUrl = wpSharedPageUrl;

function wpPrimeAsset(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && wpServiceOf(url.hostname) === 'prime' && !url.username && !url.password &&
      /\/(?:detail|dp)\/[A-Za-z0-9]+(?:\/|$)/.test(url.pathname);
  } catch { return false; }
}
function wpPrimeContentTitle(raw) {
  const title = String(raw || '').replace(/\s+/g, ' ').trim();
  return !!title && !/^(?:amazon(?:\.com)?\s*[:|–-]\s*)?(?:(?:amazon\s+)?prime\s+video)(?:\s*[:|–-]|$)/i.test(title) &&
    !/^(?:home|ads?|advertisements?|commercial|trailer|teaser|preview)$/i.test(title);
}
function wpPrimeVisibleMarker(node) {
    if (node.hidden || !String(node.textContent || '').trim()) return false;
    if (node.checkVisibility) return node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    if (node.getClientRects && !node.getClientRects().length) return false;
    if (typeof getComputedStyle === 'function') for (let el = node; el; el = el.parentElement) {
      const css = getComputedStyle(el);
      if (css.display === 'none' || css.visibility === 'hidden' || css.opacity === '0') return false;
    }
    return true;
}
function wpPrimeAdActive(doc) {
  const markers = doc.querySelectorAll('.atvwebplayersdk-adtimeindicator-text, [class*="atvwebplayersdk-ad-timer"], .atvwebplayersdk-ad-resume-message, .atvwebplayersdk-adcountdown, [data-testid="ad-countdown"]');
  return [...markers].some(wpPrimeVisibleMarker);
}
function wpPrimePreviewActive(doc) {
  return [...doc.querySelectorAll('.atvwebplayersdk-subtitle-text')].some(node =>
    wpPrimeVisibleMarker(node) && /^(?:(?:official|season\s+\d+)\s+)?(?:trailer|teaser|preview)(?:\s*\d+)?$/i.test(String(node.textContent || '').trim()));
}
var WP_ARTWORK_HOSTS = {
  youtube: ['i.ytimg.com', 'img.youtube.com'],
  netflix: ['nflxso.net', 'nflximg.net'],
  prime: ['m.media-amazon.com', 'images-na.ssl-images-amazon.com', 'images-eu.ssl-images-amazon.com', 'images-fe.ssl-images-amazon.com', 'aiv-cdn.net'],
  hulu: ['hulu.com', 'huluim.com', 'huluimcache.com'],
  peacock: ['peacocktv.com'], crunchyroll: ['crunchyroll.com', 'crunchyrollcdn.com'],
  paramount: ['paramountplus.com', 'cbsig.net'], max: ['discomax.com', 'hbomax.com'],
  disney: ['disney-plus.net', 'disneyplus.com', 'bamgrid.com'], appletv: ['mzstatic.com'],
  catalog: ['image.tmdb.org', 'archive.org'],
};
function wpPlaybackPoster(raw, service) {
  if (typeof raw !== 'string' || raw.length > 2000) return '';
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password || u.port ||
      !(WP_ARTWORK_HOSTS[service] || []).some(host => u.hostname === host || u.hostname.endsWith('.' + host)) ||
      /(?:^|[\/_-])(?:logo|favicon)(?:[\/_.-]|$)/i.test(u.pathname) || /\.svg$/i.test(u.pathname)) return '';
    // Retain image transforms, never account tokens or arbitrary tracking queries.
    for (const key of [...u.searchParams.keys()]) if (!/^(?:r|width|height|w|h|quality|q|format|fit|resize|scale|region)$/i.test(key)) u.searchParams.delete(key);
    u.hash = ''; return u.href;
  } catch { return ''; }
}
function wpPagePoster(doc, service, video) {
  const candidates = [video?.poster];
  for (const selector of ['meta[property="og:image"]', 'meta[name="twitter:image"]', '.atvwebplayersdk-poster-image img', '.atvwebplayersdk-poster img', 'img[data-testid="player-poster"]']) {
    const el = doc.querySelector(selector);
    if (el) candidates.push(el.content || el.currentSrc || el.src);
  }
  return candidates.map(raw => wpPlaybackPoster(raw, service)).find(Boolean) || '';
}
if (typeof module !== 'undefined') module.exports = { wpPrimeAsset, wpPrimeContentTitle, wpPlaybackPoster, WP_ARTWORK_HOSTS };
