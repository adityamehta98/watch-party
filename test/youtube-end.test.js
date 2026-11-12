'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
test('the end screen offers next videos, excludes replay and playlists, and escapes metadata', async () => {
  const { youtubeEndCards } = await import('../public/js/youtube-end.js');
  const html = youtubeEndCards([{ id: 'abcdefghijk', title: 'Current' }, { id: 'nextvideo12', title: '<script>bad</script>', channel: 'A & B' },
    { id: 'PLcollection', playlist: true }, { id: 'bad" onclick=' }], 'abcdefghijk');
  assert.doesNotMatch(html, /data-yid="abcdefghijk"|<script>|onclick=/);
  assert.match(html, /data-yid="nextvideo12"/); assert.match(html, /&lt;script&gt;/);
});
