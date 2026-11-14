'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { captionMetadata, parseCaptionMetadata } = require('../server/youtube-captions');
const page = tracks => `<script>var ytInitialPlayerResponse = ${JSON.stringify({ playabilityStatus: { status: 'OK' }, captions: { playerCaptionsTracklistRenderer: {
  captionTracks: tracks, translationLanguages: [{ languageCode: 'hi', languageName: { simpleText: 'Hindi' } }, { languageCode: 'es', languageName: { runs: [{ text: 'Spanish' }] } }],
} } })};</script>`;
const asr = { languageCode: 'en', name: { simpleText: 'English (auto-generated)' }, kind: 'asr', vssId: 'a.en', isTranslatable: true, baseUrl: 'https://www.youtube.com/api/timedtext?signature=private' };

test('ASR-only video exposes original captions and all translation targets without signed URLs', () => {
  const result = parseCaptionMetadata(page([asr]));
  assert.equal(result.tracks[0].kind, 'asr'); assert.equal(result.tracks[0].vssId, 'a.en');
  assert.deepEqual(result.translations, [{ languageCode: 'hi', displayName: 'Hindi' }, { languageCode: 'es', displayName: 'Spanish' }]);
  assert.doesNotMatch(JSON.stringify(result), /baseUrl|signature|private/);
  assert.deepEqual(parseCaptionMetadata(page([])), { tracks: [], translations: [] });
  assert.throws(() => parseCaptionMetadata('<html>consent required</html>'), /did not return/);
  assert.throws(() => parseCaptionMetadata('<script>var ytInitialPlayerResponse = {"playabilityStatus":{"status":"LOGIN_REQUIRED"}};</script>'), /unavailable/);
});

test('caption metadata validates video IDs, uses a timeout, coalesces requests and retries failures', async () => {
  await assert.rejects(captionMetadata('https://local/', () => assert.fail()), /Invalid/);
  let calls = 0;
  const fetch = async (url, options) => { calls++; assert.match(url, /watch\?v=metadata123/); assert.ok(options.signal); return { ok: true, text: async () => page([asr]) }; };
  await Promise.all([captionMetadata('metadata123', fetch), captionMetadata('metadata123', fetch)]);
  assert.equal(calls, 1);
  await assert.rejects(captionMetadata('failure1234', async () => ({ ok: false, status: 429 })), /429/);
  assert.equal((await captionMetadata('failure1234', async () => ({ ok: true, text: async () => page([asr]) }))).translations.length, 2);
});
