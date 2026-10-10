export function detectPlatform(nav = globalThis.navigator || {}) {
  const ua = String(nav.userAgent || '');
  const ipad = /iPad/.test(ua) || (nav.platform === 'MacIntel' && Number(nav.maxTouchPoints) > 1);
  const iphone = /iPhone|iPod/.test(ua);
  const android = /Android/.test(ua);
  const safari = /Safari\//.test(ua) && !/(?:Chrome|Chromium|CriOS|Edg|EdgiOS|OPiOS|FxiOS|Android)\//.test(ua);
  return {
    ipad, iphone, android, safari,
    appleMobile: ipad || iphone,
    mobile: ipad || iphone || android,
    device: ipad ? 'iPad' : iphone ? 'iPhone' : android ? (/Mobile/.test(ua) ? 'Android phone' : 'Android tablet')
      : safari ? 'Mac (Safari)' : /Windows/.test(ua) ? 'PC' : /Mac/.test(ua) ? 'Mac' : 'computer',
  };
}

export function installTarget(platform, appleUrl = '') {
  if (platform.appleMobile) return platform.safari ? (appleUrl ? 'apple-mobile' : 'apple-mobile-unpublished') : 'apple-mobile-browser';
  if (platform.android) return 'android';
  if (platform.safari) return appleUrl ? 'mac-safari' : 'mac-safari-source';
  return 'chromium';
}

export const PLATFORM = detectPlatform();
