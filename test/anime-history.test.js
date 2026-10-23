'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AnimeHistory } = require('../server/anime-history');
const { Room } = require('../server/room');

const mashle = { anilistId: 151801, malId: 52211, animeTitle: 'Mashle', episode: 3, episodes: 12, language: 'dub' };

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-anime-history-'));
  const file = path.join(dir, 'watch-history.json');
  const history = new AnimeHistory(file);
  const rooms = [];
  const makeRoom = (store = history, animeResolve = async () => ({ url: 'https://fresh.example/master.m3u8', referer: 'https://megaplay.buzz' })) => {
    const room = new Room({ config: { adminKey: 'admin-secret-key', roomKey: 'guestsecretkey1234', room: { autoWait: false } },
      library: {}, animeHistory: store, animeResolve, animePoster: async () => '' });
    rooms.push(room);
    return room;
  };
  const client = role => {
    const messages = [];
    return { id: role + '01', name: role, role, admitted: true, perms: { playback: true },
      ws: { readyState: 1, send: raw => messages.push(JSON.parse(raw)) }, messages,
      iceFor: () => [], relayOnlyFor: () => false, media: {} };
  };
  const pick = (room, host, extra = {}) => room.selectAnime(host, { anilistId: mashle.anilistId, malId: mashle.malId,
    ep: mashle.episode, episodes: mashle.episodes, lang: mashle.language, title: mashle.animeTitle, ...extra });
  const progress = (room, host, patch = {}, flush = false) => room.onMessage(host, { type: 'anime-progress', flush,
    status: { movieId: room.movie.id, seq: room.state.seq, loaded: true, ready: true,
      position: 360, duration: 1440, seeking: false, ended: false, ...patch } });
  t.after(() => { for (const room of rooms) room.shutdown(); history.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { history, file, makeRoom, client, pick, progress };
}

test('restart resumes Mashle episode 3 at six minutes using a newly resolved stream', async t => {
  const f = fixture(t), host = f.client('host'), room = f.makeRoom();
  await f.pick(room, host);
  f.progress(room, host);
  room.shutdown();
  const restored = new AnimeHistory(f.file);
  const calls = [];
  const nextRoom = f.makeRoom(restored, async (...args) => {
    calls.push(args);
    return { url: 'https://new.example/renewed.m3u8', referer: 'https://megaplay.buzz' };
  });
  assert.equal(nextRoom.movie, null, 'opening the app does not start playback or resolve streams');
  await f.pick(nextRoom, host);
  assert.equal(nextRoom.movie.episode, 3);
  assert.equal(nextRoom.state.position, 360);
  assert.equal(nextRoom.state.playing, false, 'load must seek before the normal readiness handshake');
  assert.deepEqual(calls, [[151801, 52211, 3, 'dub']]);
  assert.equal(restored.get(151801, 3).position, 360, 'wall clock time never advances persisted progress');
  assert.doesNotMatch(fs.readFileSync(f.file, 'utf8'), /https:|m3u8|admin-secret/);
});

test('only matching, loaded, settled host playback can update history', async t => {
  const f = fixture(t), host = f.client('host'), guest = f.client('guest'), room = f.makeRoom();
  await f.pick(room, host);
  f.progress(room, host);
  const badReports = [{ movieId: 'previous-episode' }, { seq: room.state.seq - 1 }, { loaded: false },
    { seeking: true }, { ready: false }, { error: 3 }, { position: -1 }, { position: NaN }, { duration: Infinity }, { duration: 0 }];
  for (const patch of badReports) {
    f.progress(room, host, { position: 0, ...patch });
    assert.equal(f.history.get(151801, 3).position, 360, JSON.stringify(patch));
  }
  f.progress(room, guest, { position: 900 });
  assert.equal(f.history.get(151801, 3).position, 360);
  f.progress(room, host, { position: 420 }, true);
  assert.equal(new AnimeHistory(f.file).get(151801, 3).position, 420, 'an exit/pause flush is durable immediately');
});

test('watched episodes remain watched on replay, support corrections, and offer a clean restart', async t => {
  const f = fixture(t), host = f.client('host'), room = f.makeRoom();
  room.clients.set(host.id, host);
  await f.pick(room, host);
  f.progress(room, host, { position: 1296 });
  assert.equal(f.history.get(151801, 3).completed, true, '90% marks watched');
  await f.pick(room, host, { resume: true });
  assert.equal(room.state.position, 0, 'replay of a watched episode starts at the beginning');
  f.progress(room, host, { position: 12 });
  assert.equal(f.history.get(151801, 3).completed, true, 'rewatching cannot erase watched status');
  const oldSeq = room.state.seq;
  room.onMessage(host, { type: 'anime-history-mark', anilistId: 151801, episode: 3, completed: false });
  assert.equal(f.history.get(151801, 3).completed, false);
  assert.equal(room.state.position, 0);
  assert.equal(room.state.playing, false);
  f.progress(room, host, { seq: oldSeq, position: 1400 });
  assert.equal(f.history.get(151801, 3).completed, false, 'a delayed report cannot undo a manual correction');
  f.progress(room, host);
  await f.pick(room, host, { restart: true });
  assert.equal(room.state.position, 0);
  assert.equal(f.history.get(151801, 3).position, 0);
});

test('native and embedded playback share episode progress across audio languages', async t => {
  const f = fixture(t), host = f.client('host'), room = f.makeRoom();
  await f.pick(room, host);
  f.progress(room, host);
  await f.pick(room, host, { lang: 'sub' });
  assert.equal(room.state.position, 360, 'changing audio retains the episode position');
  assert.equal(f.history.list().length, 1);
  room.shutdown();
  const embedded = f.makeRoom(new AnimeHistory(f.file), async () => null);
  await f.pick(embedded, host, { lang: 'sub' });
  assert.equal(embedded.movie.kind, 'megaplay');
  assert.equal(embedded.state.position, 360);
  f.progress(embedded, host, { position: 400 }, true);
  assert.equal(new AnimeHistory(f.file).get(151801, 3).position, 400);
});

test('history is host-only in welcome messages, broadcasts, and manual changes', async t => {
  const f = fixture(t), host = f.client('host'), guest = f.client('guest'), room = f.makeRoom();
  room.clients.set(host.id, host);
  room.clients.set(guest.id, guest);
  await f.pick(room, host);
  f.progress(room, host);
  room.admit(host, true);
  room.admit(guest, true);
  assert.equal(host.messages.find(m => m.type === 'welcome').animeHistory[0].position, 360);
  assert.equal('animeHistory' in guest.messages.find(m => m.type === 'welcome'), false);
  assert.equal(guest.messages.some(m => m.type === 'anime-history'), false);
  room.onMessage(guest, { type: 'anime-history-mark', anilistId: 151801, episode: 3, completed: true });
  assert.equal(f.history.get(151801, 3).completed, false);
});

test('history retains previous episodes and clamps malformed disk records', t => {
  const f = fixture(t);
  f.history.record({ ...mashle, episode: 1 }, 1400, 1440);
  f.history.record({ ...mashle, episode: 2 }, 1400, 1440);
  f.history.record(mashle, 360, 1440);
  assert.equal(f.history.list()[0].episode, 3, 'rapid episode updates must keep the most recent episode first');
  f.history.flush();
  assert.equal(new AnimeHistory(f.file).list().filter(e => e.completed).length, 2);
  fs.writeFileSync(f.file, JSON.stringify({ episodes: [null, { anilistId: -1, episode: 1 },
    { ...mashle, position: 99999, duration: 1440, sources: ['private-url'] }] }));
  const restored = new AnimeHistory(f.file);
  assert.equal(restored.list().length, 1);
  assert.equal(restored.get(151801, 3).position, 1440);
  assert.equal('sources' in restored.list()[0], false);
});

test('progress is saved within five seconds without waiting for a pause or shutdown', t => {
  const f = fixture(t);
  let pending;
  t.mock.method(global, 'setTimeout', (callback, delay) => {
    pending = { callback, delay };
    return { unref() {} };
  });
  f.history.record(mashle, 360, 1440);
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(pending.delay, 5000);
  pending.callback();
  assert.equal(new AnimeHistory(f.file).get(151801, 3).position, 360);
});

test('a failed atomic save preserves the committed history and can be retried', t => {
  const f = fixture(t);
  f.history.record(mashle, 360, 1440);
  f.history.flush();
  const errors = [];
  f.history.onError = error => errors.push(error.message);
  f.history.record(mashle, 420, 1440);
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('Disk unavailable'); });
  f.history.flush();
  assert.deepEqual(errors, ['Disk unavailable']);
  assert.equal(new AnimeHistory(f.file).get(151801, 3).position, 360);
  rename.mock.restore();
  f.history.flush();
  assert.equal(new AnimeHistory(f.file).get(151801, 3).position, 420);
});

test('search cover art survives playback reports, episode changes, and restarts', async t => {
  const f = fixture(t), host = f.client('host'), room = f.makeRoom();
  const poster = 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/mashle.jpg';
  await f.pick(room, host, { poster });
  f.progress(room, host, {}, true);
  assert.equal(new AnimeHistory(f.file).get(151801, 3).poster, poster);
  await f.pick(room, host, { ep: 4 });
  assert.equal(f.history.get(151801, 4).poster, poster, 'Next episode reuses the same search artwork');
  f.progress(room, host, { position: 50 }, true);
  assert.equal(new AnimeHistory(f.file).get(151801, 4).poster, poster);
});

test('older history receives artwork without changing timestamps, positions, or series ordering', async t => {
  const f = fixture(t), room = f.makeRoom();
  f.history.record({ ...mashle, episode: 1 }, 1400, 1440);
  f.history.record(mashle, 360, 1440);
  const before = f.history.list();
  let calls = 0;
  room.animePoster = async id => { assert.equal(id, 151801); calls++; return 'https://s4.anilist.co/mashle.jpg'; };
  await room.fillAnimePosters();
  await room.fillAnimePosters();
  assert.equal(calls, 1, 'one lookup per series');
  assert.deepEqual(f.history.list().map(({ poster, ...entry }) => entry), before.map(({ poster, ...entry }) => entry));
  assert.ok(new AnimeHistory(f.file).list().every(entry => entry.poster === 'https://s4.anilist.co/mashle.jpg'));
  assert.equal(f.history.setPoster(151801, 'javascript:alert(1)'), false);
  assert.equal(f.history.setPoster(151801, 'https://tracking.example/mashle.jpg'), false);
});

test('removing Continue watching preserves episode history and stays removed across reports and restarts', async t => {
  const f = fixture(t), host = f.client('host'), guest = f.client('guest'), room = f.makeRoom();
  f.history.record({ ...mashle, episode: 1 }, 1400, 1440);
  await f.pick(room, host);
  f.progress(room, host);
  const before = f.history.list();
  room.onMessage(guest, { type: 'anime-continue-dismiss', anilistId: 151801 });
  assert.deepEqual(f.history.hidden(), [], 'guests cannot dismiss the host card');
  room.onMessage(host, { type: 'anime-continue-dismiss', anilistId: 151801 });
  assert.deepEqual(f.history.list(), before, 'removing a card never changes episode records');
  let restored = new AnimeHistory(f.file);
  assert.deepEqual(restored.hidden(), [151801]);
  assert.equal(restored.get(151801, 1).completed, true);
  assert.equal(restored.get(151801, 3).position, 360);
  f.progress(room, host, { position: 420 }, true);
  restored = new AnimeHistory(f.file);
  assert.deepEqual(restored.hidden(), [151801], 'ongoing playback cannot undo dismissal');
  assert.equal(restored.get(151801, 3).position, 420);
  await f.pick(room, host, { resume: true });
  assert.deepEqual(f.history.hidden(), [], 'explicit episode selection returns the card');
  assert.equal(f.history.get(151801, 1).completed, true);
});
