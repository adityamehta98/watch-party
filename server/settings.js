'use strict';

function cleanAppleExtensionUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' && ['apps.apple.com', 'testflight.apple.com'].includes(url.hostname.toLowerCase()) ? url.href : '';
  } catch { return ''; }
}

module.exports = { cleanAppleExtensionUrl };
