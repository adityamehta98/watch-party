'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Room } = require('../server/room');
const { AnimeHistory } = require('../server/anime-history');
const { clearSessionCache } = require('../server/session-cache');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-shared-progress-'));
  const file = path.join(root, 'watch-history.json'), history = new AnimeHistory(file);
  const room = new Room({ config: { roomKey: 'guesttestsecret1234', room: { autoWait: false } }, library: {}, animeHistory: history });
  const client = role => ({ id: role + 'client', name: role, role, admitted: true, perms: { playback: true }, ws: { readyState: 1, send() {} } });
  const host = client('host'), guest = client('guest');
  room.clients.set(host.id, host); room.clients.set(guest.id, guest);
  room.selectUrl(host, 'https://www.netflix.com/watch/12345', true, { title: 'Test movie', position: 0, duration: 7200 });
  const progress = (who = host, status = {}, url = room.movie.url) => room.onMessage(who, { type: 'playback-progress', flush: true, url,
    status: { movieId: room.movie.id, seq: room.state.seq, loaded: true, ready: true, position: 726, duration: 7200, ...status } });
  t.after(() => { room.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, file, history, room, host, guest, progress };
}
test('Netflix viewing survives return Home, process restart, and resumes the exact asset and time', t => {
  const f = fixture(t), id = f.room.movie.id;
  f.progress(); f.room.selectMovie(f.host, null); f.room.shutdown();
  const restored = new AnimeHistory(f.file);
  assert.equal(restored.playbackList()[0].position, 726);
  f.room.animeHistory = restored;
  f.room.onMessage(f.host, { type: 'select-playback', id });
  assert.equal(f.room.movie.url, 'https://www.netflix.com/watch/12345');
  assert.equal(f.room.state.position, 726);
  assert.equal(f.room.state.playing, true);
  assert.equal(f.room.chat.length, 1, 'only the new resume message remains after shutdown');
});
test('guest, stale-title, preview, seek and unsettled reports cannot overwrite real progress', t => {
  const f = fixture(t); f.progress();
  f.progress(f.guest, { position: 1 });
  for (const invalid of [{ movieId: 'old' }, { seq: -1 }, { ready: false }, { loaded: false }, { seeking: true }, { blocked: true }, { ad: true }, { preview: true }, { error: 4 }, { position: NaN }, { duration: 0 }]) f.progress(f.host, { position: 1, ...invalid });
  f.progress(f.host, { position: 1 }, 'https://www.netflix.com/browse');
  assert.equal(f.history.playbackList()[0].position, 726);
});
test('enriching a saved Netflix episode keeps its position, order, and resume URL through restart', async t => {
  const f = fixture(t);
  f.progress();
  const before = f.history.playbackList()[0];
  let calls = 0;
  f.room.netflixMetadata = async url => {
    calls++; assert.equal(url, before.url);
    return { title: 'Akka', seriesId: '81772075', episode: 1, episodeTitle: 'The Sisterhood', poster: 'https://occ-1.nflxso.net/dnm/api/v6/art.jpg' };
  };
  await Promise.all([f.room.fillNetflixCards(), f.room.fillNetflixCards()]);
  assert.equal(calls, 1);
  const restored = new AnimeHistory(f.file).playbackList()[0];
  assert.deepEqual({ ...restored, netflix: undefined }, { ...before, netflix: undefined });
  assert.equal(restored.netflix.episode, 1);
  assert.equal(restored.netflix.seriesId, '81772075');
  f.progress(f.host, { position: 800 });
  const updated = new AnimeHistory(f.file).playbackList()[0];
  assert.equal(updated.position, 800);
  assert.deepEqual(updated.netflix, restored.netflix);
});
test('old extension progress imports once and preserves newer host progress and hidden cards', t => {
  const f = fixture(t), entry = { service: 'netflix', url: 'https://www.netflix.com/watch/99999?trackId=secret', title: 'Earlier movie', position: 90, duration: 7000, lastWatched: Date.now() - 1000 };
  f.room.onMessage(f.guest, { type: 'playback-import', entries: [entry] });
  assert.equal(f.history.playbackList().length, 0);
  f.room.onMessage(f.host, { type: 'playback-import', entries: [entry] });
  const imported = f.history.playbackList()[0];
  assert.equal(imported.url, 'https://www.netflix.com/watch/99999');
  f.history.dismissPlayback(imported.id);
  f.room.onMessage(f.host, { type: 'playback-import', entries: [{ ...entry, position: 1 }] });
  assert.equal(f.history.playbackList()[0].hidden, true);
  assert.equal(f.history.playbackList()[0].position, 90);
  assert.doesNotMatch(fs.readFileSync(f.file, 'utf8'), /trackId|secret/);
});

for (const kind of ['file', 'netflix', 'youtube', 'catalog']) test(`a dismissed ${kind} card returns on a new selection, retains progress and survives restart`, t => {
  const f = fixture(t);
  f.room.library = { playable: id => ({ id, title: 'Local movie', duration: 7200, subs: [] }) };
  f.room.catalog = { resolve: () => ({ ref: { type: 'movie', tmdbId: 99 }, sourceId: 'test', duration: 7200 }) };
  const select = () => {
    if (kind === 'file') f.room.selectMovie(f.host, 'localmovie1');
    else if (kind === 'catalog') f.room.selectCatalog(f.host, { ref: { type: 'movie', tmdbId: 99 }, title: 'Catalog movie' });
    else f.room.selectUrl(f.host, kind === 'netflix' ? 'https://www.netflix.com/watch/12345' : 'https://www.youtube.com/watch?v=abcdefghijk', kind === 'netflix');
  };
  f.room.selectMovie(f.host, null); select(); f.progress();
  const id = f.room.movie.id;
  const netflixArtwork = { title: 'Akka', episode: 1, episodeTitle: 'The Sisterhood', poster: 'https://occ-1.nflxso.net/dnm/api/v6/original-netflix.jpg?r=123' };
  if (kind === 'netflix') f.history.setNetflixMetadata(id, f.room.movie.url, netflixArtwork);
  f.history.dismissPlayback(id);
  f.progress(f.host, { position: 727 });
  assert.equal(f.history.playbackEntries.get(id).hidden, true, 'ordinary status cannot undo the cross button');
  f.room.selectMovie(f.host, null); select();
  const restored = new AnimeHistory(f.file).playbackEntries.get(id);
  assert.equal(restored.hidden, false);
  assert.equal(restored.position, 727);
  if (kind === 'netflix') assert.equal(restored.netflix.poster, netflixArtwork.poster, 'replay must retain the same Netflix thumbnail');
  f.progress(f.host, { position: 800 });
  assert.equal(new AnimeHistory(f.file).playbackEntries.get(id).hidden, false);
});
test('cache cleanup removes generated data and preserves progress, settings, certificates and unrelated files', t => {
  const f = fixture(t); f.progress();
  for (const name of ['config.json', 'https-cert.json', 'notes.txt', 'probe-cache.json', 'status.json', '123456abcdef.mp4']) fs.writeFileSync(path.join(f.root, name), name);
  fs.mkdirSync(path.join(f.root, 'subtitles')); fs.writeFileSync(path.join(f.root, 'subtitles', 'test.vtt'), 'caption');
  clearSessionCache(f.root);
  for (const name of ['watch-history.json', 'config.json', 'https-cert.json', 'notes.txt']) assert.equal(fs.existsSync(path.join(f.root, name)), true, name);
  for (const name of ['probe-cache.json', 'status.json', '123456abcdef.mp4', 'subtitles']) assert.equal(fs.existsSync(path.join(f.root, name)), false, name);
  assert.equal(new AnimeHistory(f.file).playbackList()[0].position, 726);
});
