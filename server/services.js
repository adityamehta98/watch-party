'use strict';
// Streaming services Watch Party can keep in sync. Each person watches from their own account;
// Watch Party only syncs play / pause / seek (plus chat and webcams).
const SERVICES = [
  { id: 'youtube', name: 'YouTube', hosts: ['youtube.com', 'youtu.be'] },
  { id: 'netflix', name: 'Netflix', hosts: ['netflix.com'] },
  { id: 'prime', name: 'Prime Video', hosts: ['primevideo.com', 'amazon.com'] },
  { id: 'hulu', name: 'Hulu', hosts: ['hulu.com'] },
  { id: 'peacock', name: 'Peacock', hosts: ['peacocktv.com'] },
  { id: 'crunchyroll', name: 'Crunchyroll', hosts: ['crunchyroll.com'] },
  { id: 'paramount', name: 'Paramount+', hosts: ['paramountplus.com'] },
  { id: 'max', name: 'Max', hosts: ['max.com', 'hbomax.com'] },
  { id: 'disney', name: 'Disney+', hosts: ['disneyplus.com'] },
  { id: 'appletv', name: 'Apple TV+', hosts: ['tv.apple.com'] },
];

function youtubeId(u) {
  const ok = id => (/^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null);
  if (u.hostname.replace(/^www\./, '') === 'youtu.be') return ok(u.pathname.slice(1).split('/')[0]);
  const v = u.searchParams.get('v');
  if (v) return ok(v);
  const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/);
  return m ? ok(m[1]) : null;
}

// Addresses a "custom site" may never point at: the guests' own computers and home networks.
function privateHost(host) {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.')) return true;
  if (/^\[|:/.test(host)) return true; // IPv6 literals
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

// opts.custom: the host's "custom site" (any website with a video, played inside the Watch Party window).
function identify(raw, opts = {}) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  const svc = SERVICES.find(s => s.hosts.some(h => host === h || host.endsWith('.' + h)));
  if (!svc) {
    if (!opts.custom || privateHost(host) || u.username || u.password) return null;
    u.hash = '';
    u.pathname = u.pathname.replace(/\/+$/, '') || '/';
    // (the query stays: on most sites it's what picks the episode)
    return { service: 'custom', name: host.replace(/^www\./, ''), url: u.toString(), custom: true };
  }
  u.protocol = 'https:';
  u.hash = '';
  // trim tracking bits (keep in step with wpCanonicalUrl in the extension and canonicalUrl in the page)
  if (svc.id !== 'youtube') u.search = '';
  u.pathname = u.pathname.replace(/\/ref=[^/]*$/, '').replace(/\/+$/, '') || '/';
  if (svc.id === 'netflix') { const m = /\/watch\/(\d+)/.exec(u.pathname); if (m) u.pathname = `/watch/${m[1]}`; }
  const out = { service: svc.id, name: svc.name, url: u.toString() };
  if (svc.id === 'youtube') {
    out.videoId = youtubeId(u);
    if (!out.videoId) return null;
  }
  if (svc.id === 'prime' && host.endsWith('amazon.com') && !/\/(gp\/video|dp|video)\//.test(u.pathname + '/')) return null;
  return out;
}

module.exports = { SERVICES, identify };
