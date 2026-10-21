'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SubtitleSearch, episodeTarget, mappedEpisode } = require('../server/subtitle-search');
const { CaptionLibrary } = require('../server/captions');
const { Room } = require('../server/room');
const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello\n';
const mapping = {
  'anilist:1': { 'tmdb_show:30991:s1': { '1-26': '1-26' } },
  'anilist:20958': { 'tmdb_show:1429:s2': { '1-12': '1-12' } },
  'anilist:108632': { 'tmdb_show:65942:s1': { '1-13': '26-38' } },
  'anilist:164': { 'tmdb_movie:128': { '1': '1' } },
};
function fixture(t, fetcher) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-subsearch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const library = new CaptionLibrary(path.join(root, 'subtitles'));
  fs.writeFileSync(path.join(root, 'anime-subtitle-mappings-v3.json'), JSON.stringify(mapping));
  const config = { wyzieKey: 'secret-key' };
  return { root, library, config, service: new SubtitleSearch({ library, config, fetcher }) };
}
const movie = (id = 1, ep = 1) => ({ id: `a${id}-${ep}`, kind: 'anime', anilistId: id, episode: ep, language: 'sub', subs: [] });

test('subtitle matching uses exact anime season, split-cour offset and movie mappings', () => {
  assert.deepEqual(episodeTarget(mapping, movie(20958, 3)), { id: '1429', season: 2, episode: 3 });
  assert.deepEqual(episodeTarget(mapping, movie(108632, 1)), { id: '65942', season: 1, episode: 26 });
  assert.deepEqual(episodeTarget(mapping, movie(164, 1)), { id: '128' });
  assert.equal(episodeTarget(mapping, movie(20958, 13)), null);
  assert.equal(episodeTarget(mapping, movie(999999, 1)), null);
  assert.equal(mappedEpisode({ '1-12': '1-24|2' }, 3), null, 'merged episodes require more than a single subtitle file');
  assert.equal(mappedEpisode({ '1-12': '1-6,8-13' }, 7), 8);
  assert.equal(mappedEpisode({ '14-': '13-' }, 20), 19);
});

test('a party shares one bounded subtitle download, persists it and scopes it by episode and audio', async t => {
  let calls = 0;
  const f = fixture(t, async url => {
    calls++;
    const query = new URL(url).searchParams;
    assert.equal(query.get('id'), '1429');
    assert.equal(query.get('season'), '2');
    assert.equal(query.get('episode'), '3');
    assert.equal(query.get('language'), 'en');
    assert.equal(query.get('to'), 'vtt');
    return new Response(VTT);
  });
  const m = movie(20958, 3);
  const results = await Promise.all([f.service.find(m, 'en'), f.service.find(m, 'en')]);
  assert.equal(calls, 1);
  assert.ok(results.every(r => r.state === 'ready'));
  assert.equal(f.library.tracks(m)[0].automatic, true);
  assert.equal(f.library.tracks(movie(20958, 4)).length, 0);
  assert.equal(f.library.tracks({ ...m, language: 'dub' }).length, 0);
  assert.doesNotMatch(JSON.stringify(f.library.tracks(m)), /secret-key|wyzie/);
  assert.equal((await f.service.find(m, 'en')).state, 'ready');
  assert.equal(calls, 1);
});

test('lookup reports missing key, bad key, quota and missing captions without repeated provider calls', async t => {
  let calls = 0, status = 400;
  const f = fixture(t, async () => { calls++; return new Response('{}', { status }); });
  f.config.wyzieKey = '';
  assert.equal((await f.service.find(movie(), 'en')).state, 'setup');
  assert.equal(calls, 0);
  for (const [code, expected] of [[400, 'unavailable'], [403, 'setup'], [429, 'error'], [503, 'error']]) {
    status = code;
    f.config.wyzieKey = `key-${code}`;
    assert.equal((await f.service.find(movie(), 'en')).state, expected);
    await f.service.find(movie(), 'en');
  }
  assert.equal(calls, 4);
  assert.equal(f.library.tracks(movie()).length, 0);
});

test('invalid and oversized provider files never become tracks', async t => {
  const f = fixture(t, async () => new Response('<html>Provider error</html>'));
  assert.equal((await f.service.find(movie(), 'en')).state, 'error');
  f.config.wyzieKey = 'another-key';
  f.service.fetch = async () => new Response(VTT, { headers: { 'content-length': String(3 * 1024 * 1024) } });
  assert.equal((await f.service.find(movie(), 'en')).state, 'error');
  assert.equal(f.library.tracks(movie()).length, 0);
});

test('cache eviction removes oldest automatic files while preserving manual subtitles', async t => {
  const f = fixture(t);
  const dir = path.join(f.library.root, 'anime-1', 'sub');
  fs.mkdirSync(dir, { recursive: true });
  const old = path.join(dir, '1.en.auto.vtt'), recent = path.join(dir, '2.en.auto.vtt'), manual = path.join(dir, '3.en.vtt');
  for (const file of [old, recent, manual]) fs.writeFileSync(file, VTT);
  fs.utimesSync(old, new Date(0), new Date(0));
  await f.library.pruneAutomatic(Buffer.byteLength(VTT), 0);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(recent), true);
  assert.equal(fs.existsSync(manual), true);
});

test('late subtitle results cannot replace a newer episode or change playback state', async t => {
  let finish;
  const search = { configured: () => true, find: () => new Promise(resolve => { finish = resolve; }) };
  const f = fixture(t);
  const room = new Room({ config: { adminKey: 'host', roomKey: 'guestsecretkey1234' }, library: {}, captions: f.library, subtitleSearch: search });
  t.after(() => room.shutdown());
  const messages = [];
  room.broadcast = message => messages.push(message);
  room.movie = movie();
  const before = { ...room.state };
  const task = room.findSubtitles({ admitted: true }, { movieId: room.movie.id, lang: 'en' });
  assert.equal(messages[0].movie.subtitleSearch.en.state, 'searching');
  room.movie = movie(1, 2);
  finish({ state: 'ready' });
  await task;
  assert.equal(messages.length, 1);
  assert.deepEqual(room.state, before);
  assert.equal(room.movie.episode, 2);
  assert.doesNotMatch(JSON.stringify(room.publicSettings(false)), /secret-key/);
});
