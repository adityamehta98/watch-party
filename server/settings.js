'use strict';

function migrateConfig(value) {
  const c = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
  // Version-one defaults could silently force a local bind or Cloudflare tunnel after upgrading.
  if (Object.keys(c).length && !c.version) {
    if (c.bind === '127.0.0.1') delete c.bind;
    if (c.tunnel === 'cloudflare') delete c.tunnel;
  }
  delete c.iceServers;
  delete c.safariExtensionUrl; // retired extension install setting
  c.version = 2;
  return c;
}

module.exports = { migrateConfig };
