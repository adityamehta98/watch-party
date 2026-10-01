// Which streaming service a page belongs to (shared by the extension's scripts).
const WP_SERVICES = [
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
const WP_SERVICE_DOMAINS = ['netflix.com', 'primevideo.com', 'amazon.com', 'hulu.com', 'peacocktv.com', 'crunchyroll.com',
  'paramountplus.com', 'max.com', 'hbomax.com', 'disneyplus.com', 'apple.com'];
if (typeof self !== 'undefined') self.WP_SERVICE_DOMAINS = WP_SERVICE_DOMAINS;

// The "same title" test. Streaming sites add tracking bits to their links (?trackId=…, /ref=…) and
// rewrite them while you watch, so compare a trimmed version, or the room would think every little
// change is a new show and keep reloading everyone's player (and their sign-in pages).
function wpCanonicalUrl(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch { return ''; }
  const svc = wpServiceOf(u.hostname);
  if (!svc) return '';
  u.hash = '';
  if (svc === 'youtube') { const v = u.searchParams.get('v'); u.search = v ? `?v=${v}` : ''; }
  else u.search = '';
  let p = u.pathname.replace(/\/ref=[^/]*$/, '').replace(/\/+$/, '');
  if (svc === 'netflix') { const m = /\/watch\/(\d+)/.exec(p); if (m) p = `/watch/${m[1]}`; }
  return `https://${u.hostname.toLowerCase()}${p}${u.search}`;
}
if (typeof self !== 'undefined') self.wpCanonicalUrl = wpCanonicalUrl;
