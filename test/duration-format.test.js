'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('all Continue watching cards use hours, minutes and seconds for long media', async () => {
  const { playbackResumeCard } = await import('../public/js/playback-resume.js');
  const { animeResumeCard } = await import('../public/js/anime-resume.js');
  for (const kind of ['file', 'service', 'youtube', 'catalog']) {
    const html = playbackResumeCard({ id: 'movie', kind, title: 'Movie', position: 4356, duration: 10009,
      service: kind === 'service' ? 'netflix' : kind, netflix: kind === 'service' ? {
        title: 'Akka', episode: 1, poster: 'https://occ-1.nflxso.net/dnm/api/v6/original.jpg',
      } : undefined }, true);
    assert.match(html, /1:12:36 \/ 2:46:49/);
    assert.doesNotMatch(html, /72:36|166:49/);
    if (kind === 'service') assert.match(html, /src="https:\/\/occ-1\.nflxso\.net\/dnm\/api\/v6\/original\.jpg"/);
  }
  const anime = animeResumeCard({ anilistId: 1, animeTitle: 'Anime movie', episode: 1, position: 4356, duration: 10009 });
  assert.match(anime, /1:12:36 \/ 2:46:49/);
  assert.doesNotMatch(anime, /72:36|166:49/);
});

test('player, library and extension side panel use the same duration format', () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');
  const sidebar = fs.readFileSync(path.join(__dirname, '../extension/sidebar.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(app.slice(app.indexOf('function fmtTime('), app.indexOf('function fmtEta(')) +
    sidebar.slice(sidebar.indexOf('function fmt('), sidebar.indexOf('let lastChatKey')), context);
  for (const [value, expected] of [[4356, '1:12:36'], [10009, '2:46:49'], [3599, '59:59'], [3600, '1:00:00'], [0, '0:00']]) {
    assert.equal(context.fmtTime(value), expected);
    assert.equal(context.fmtDur(value), expected);
    assert.equal(context.fmt(value), expected);
  }
});

test('saved scene labels use the same clock format after an hour', t => {
  const { Room } = require('../server/room');
  const room = new Room({ config: { roomKey: 'testroomsecret1234' }, library: {} });
  t.after(() => room.shutdown());
  room.movie = { id: 'movie', kind: 'service', duration: 7200 };
  room.state = { ...room.state, position: 4356, playing: false };
  room.onMessage({ admitted: true, role: 'host', id: 'hostclient', name: 'Host' }, { type: 'bookmark' });
  assert.equal(room.bookmarks[0].label, 'Scene at 1:12:36');
});
