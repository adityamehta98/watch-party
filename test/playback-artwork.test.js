'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { cleanPlayback } = require('../server/playback-history');
const { AnimeHistory } = require('../server/anime-history');
const { Room } = require('../server/room');
const { wpPlaybackPoster } = require('../extension/services');

test('existing YouTube history gains the video thumbnail without changing its progress', async () => {
  const entry = cleanPlayback({ id: 'youtube1', kind: 'youtube', service: 'youtube', title: 'A video',
    url: 'https://www.youtube.com/watch?v=abcdefghijk', position: 504, duration: 2577, updatedAt: 42 });
  assert.equal(entry.poster, 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg');
  assert.equal(entry.position, 504); assert.equal(entry.updatedAt, 42);
  const source = fs.readFileSync(path.join(__dirname, '../public/js/playback-resume.js'), 'utf8');
  const { playbackResumeCard } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  assert.match(playbackResumeCard(entry), /<img[^>]+i\.ytimg\.com\/vi\/abcdefghijk\/hqdefault\.jpg/);
  assert.match(playbackResumeCard(entry), /8:24 \/ 42:57/);
});

test('service artwork is accepted only from that service and cannot retain credentials or tracking tokens', () => {
  const prime = 'https://m.media-amazon.com/images/M/poster.jpg';
  assert.equal(wpPlaybackPoster(prime + '?token=secret&width=400#secret', 'prime'), prime + '?width=400');
  for (const raw of ['http://m.media-amazon.com/images/M/p.jpg', 'https://user:secret@m.media-amazon.com/p.jpg',
    'https://m.media-amazon.com:8080/p.jpg', 'https://m.media-amazon.com.attacker.test/p.jpg', 'data:image/png;base64,AA', 'https://127.0.0.1/p.jpg']) {
    assert.equal(wpPlaybackPoster(raw, 'prime'), '');
  }
  assert.equal(wpPlaybackPoster(prime, 'hulu'), '');
});

test('streaming page artwork reaches durable history, survives missing later metadata, and never saves an ad image', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-artwork-'));
  const history = new AnimeHistory(path.join(root, 'history.json'));
  const room = new Room({ config: { room: {} }, library: {}, animeHistory: history });
  t.after(() => { room.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  const host = { id: 'hostclient', role: 'host', name: 'Host', admitted: true, perms: { playback: true }, ws: { readyState: 1, send() {} } };
  room.selectUrl(host, 'https://www.primevideo.com/detail/CONTENT1', true);
  const poster = 'https://m.media-amazon.com/images/M/film.jpg';
  room.movieMeta(host, { id: room.movie.id, title: 'A real film', duration: 1800, poster });
  history.recordPlayback(room.movie, 120, 1800); history.flush();
  const restored = new AnimeHistory(history.file).playbackList()[0];
  assert.equal(restored.poster, poster);
  history.recordPlayback({ ...room.movie, poster: '' }, 125, 1800);
  assert.equal(history.playbackList()[0].poster, poster);
  room.clients.set('host', host);
  room.onMessage(host, { type: 'playback-progress', url: room.movie.url, status: { loaded: true, ready: true, ad: true, movieId: room.movie.id, seq: room.state.seq, position: 2, duration: 15 } });
  assert.equal(history.playbackList()[0].position, 125);
});

test('the service script extracts a service-owned poster and ignores an unrelated image', () => {
  const context = vm.createContext({ URL });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/services.js'), 'utf8'), context);
  const doc = { querySelector: selector => selector.includes('og:image') ? { content: 'https://m.media-amazon.com/images/M/film.jpg?auth=private' } : null };
  assert.equal(context.wpPagePoster(doc, 'prime', { poster: 'https://untrusted.test/ad.jpg' }), 'https://m.media-amazon.com/images/M/film.jpg');
});
