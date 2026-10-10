'use strict';

function manifest(startUrl) {
  if (!/^\/(?:host|join)\/[A-Za-z0-9]+$/.test(startUrl)) throw new Error('invalid PWA start URL');
  return {
    id: startUrl,
    name: 'Watch Party',
    short_name: 'Watch Party',
    description: 'Private synchronized movie rooms with chat, reactions and manual streaming-service sync.',
    start_url: startUrl,
    scope: '/',
    display: 'standalone',
    display_override: ['window-controls-overlay', 'standalone'],
    orientation: 'any',
    background_color: '#0a0b0e',
    theme_color: '#0a0b0e',
    categories: ['entertainment', 'social'],
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
    shortcuts: [{ name: 'Open room controls', short_name: 'Room controls', url: startUrl, icons: [{ src: '/icon-192.png', sizes: '192x192' }] }],
    launch_handler: { client_mode: ['navigate-existing', 'auto'] },
  };
}

module.exports = { manifest };
