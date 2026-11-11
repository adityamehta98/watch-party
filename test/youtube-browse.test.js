'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { search, parsePage } = require('../server/youtube');
const html = nodes => `<script>var ytInitialData = ${JSON.stringify({ contents: nodes })};</script>`;
const video = (id, type = 'compactVideoRenderer') => ({ [type]: { videoId: id, title: { simpleText: id }, lengthText: { simpleText: '4:12' } } });

test('recommendations use the watched video, exclude it, and keep related video metadata', async () => {
  let requested;
  const result = await search('Related fixture', async url => { requested = url; return { ok: true, text: async () => html([video('abcdefghijk'), video('nextvideo12')]) }; }, { mode: 'related', id: 'abcdefghijk' });
  assert.match(requested, /\/watch\?v=abcdefghijk/);
  assert.deepEqual(result.map(v => v.id), ['nextvideo12']);
  assert.equal(result[0].duration, '4:12');
});

test('playlist discovery and playlist contents are distinct from ordinary video search', async () => {
  const id = 'PLabcdefghijk12345';
  const playlist = { playlistRenderer: { playlistId: id, title: { simpleText: 'A collection' }, videoCount: { simpleText: '2' } } };
  const fetch = async () => ({ ok: true, text: async () => html([playlist, video('abcdefghijk', 'playlistVideoRenderer'), video('nextvideo12', 'playlistVideoRenderer')]) });
  const lists = await search('Playlist fixture', fetch, { mode: 'playlists' });
  assert.equal(lists.length, 1); assert.equal(lists[0].playlist, true);
  const items = await search('Playlist fixture', fetch, { mode: 'playlist', id });
  assert.deepEqual(items.map(v => v.id), ['abcdefghijk', 'nextvideo12']);
});

test('modern playlist cards are parsed and invalid IDs never reach the network', async () => {
  const nodes = [{ lockupViewModel: { contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST', contentId: 'PLmodernplaylist', metadata: { lockupMetadataViewModel: { title: { content: 'Modern playlist' } } } } }];
  assert.equal(parsePage(html(nodes))[0].title, 'Modern playlist');
  await assert.rejects(search('unsafe', () => assert.fail('must not fetch'), { mode: 'playlist', id: 'https://private.test/' }), /Invalid/);
});

test('recommendations and playlists do not share a query-only cache entry', async () => {
  let count = 0;
  const fetch = async () => { count++; return { ok: true, text: async () => html([video('nextvideo12')]) }; };
  await search('Cache fixture', fetch, { mode: 'related', id: 'abcdefghijk' });
  await search('Cache fixture', fetch, { mode: 'related', id: 'different12' });
  assert.equal(count, 2);
});
