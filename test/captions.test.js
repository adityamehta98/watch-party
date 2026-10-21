'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { CaptionLibrary } = require('../server/captions');
const { Room } = require('../server/room');

test('saved captions follow the anime episode and audio edition without changing room playback', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-captions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'anime-21175', 'dub');
  fs.mkdirSync(dir, { recursive: true });
  for (const episode of [25, 26]) fs.writeFileSync(path.join(dir, `${episode}.en.vtt`), `WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nEpisode ${episode}\n`);
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'private');
  const captions = new CaptionLibrary(root);
  const room = new Room({ config: { adminKey: 'admin-key', roomKey: 'guestsecretkey1234' }, library: {}, save() {}, captions });
  t.after(() => room.shutdown());
  room.movie = { id: 'a25', kind: 'anime', anilistId: 21175, episode: 25, language: 'dub', title: 'Episode 25', subs: [{ key: 's0', label: 'English', lang: '', url: '/provider-failing.vtt' }] };
  room.state = { movieId: 'a25', playing: true, position: 100, anchor: Date.now(), seq: 10 };
  const before = { ...room.state };
  const movie = room.publicMovie();
  assert.equal(movie.subs[0].key, 'saved-en');
  assert.equal(movie.subs[0].local, true);
  assert.equal(movie.subs[1].key, 's0');
  assert.deepEqual(room.state, before);
  assert.equal(captions.tracks({ ...room.movie, language: 'sub' }).length, 0);
  assert.equal(captions.tracks({ ...room.movie, kind: 'file' }).length, 0);
  assert.equal(captions.tracks({ ...room.movie, anilistId: '../' }).length, 0);
  assert.equal(captions.fileFor(room.movie, '/captions/anime/21175/dub/secret.txt'), null);
  assert.deepEqual(new CaptionLibrary(root).tracks(room.movie), captions.tracks(room.movie), 'files survive server restarts');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    captions.serve(req, res, url.pathname, url.searchParams.get('k'), { room });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = (url, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: url, method }, res => {
      let body = '';
      res.setEncoding('utf8'); res.on('data', part => { body += part; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject); req.end();
  });
  const first = movie.subs[0].url;
  const authorized = `${first}?k=guestsecretkey1234`;
  assert.equal((await request(first)).status, 404);
  assert.equal((await request(`${first}?k=wrong`)).status, 404);
  assert.equal((await request(`${first}?k=admin-key`)).status, 404, 'remote admin keys are rejected');
  const response = await request(authorized);
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^text\/vtt/);
  assert.match(response.body, /Episode 25/);
  assert.equal((await request(authorized, 'HEAD')).body, '');
  assert.equal((await request(authorized, 'POST')).status, 404);
  room.movie = { ...room.movie, id: 'a26', episode: 26 };
  assert.equal((await request(authorized)).status, 404, 'old episodes are no longer served');
  const next = room.publicMovie().subs[0];
  assert.match(next.url, /26\.en\.vtt$/);
  assert.match((await request(`${next.url}?k=guestsecretkey1234`)).body, /Episode 26/);
});
