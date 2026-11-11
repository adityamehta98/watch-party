'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const entries = async values => (await import('../public/js/playback-resume.js')).playbackResumeEntries(values);
const movie = { id: 'asset', kind: 'service', position: 3300, duration: 3600, updatedAt: 1 };

test('every streaming service uses the same inclusive five-minute completion boundary', async () => {
  for (const service of ['youtube', 'netflix', 'prime', 'hulu', 'peacock', 'crunchyroll', 'paramount', 'max', 'disney', 'appletv', 'custom']) {
    assert.equal((await entries([{ ...movie, service }])).length, 0, service);
    assert.equal((await entries([{ ...movie, service, position: 3299 }])).length, 1, service);
  }
});

test('short videos remain visible before halfway and complete at halfway without hiding untouched videos', async () => {
  for (const duration of [15, 120, 599, 600]) {
    assert.equal((await entries([{ ...movie, service: 'youtube', duration, position: duration / 2 - .1 }])).length, 1);
    assert.equal((await entries([{ ...movie, service: 'youtube', duration, position: duration / 2 }])).length, 0);
    assert.equal((await entries([{ ...movie, service: 'youtube', duration, position: 0 }])).length, 1);
  }
});

test('the reported YouTube episode disappears while its saved progress and a newly replayed position remain usable', async () => {
  const episode = { ...movie, service: 'youtube', position: 42 * 60 + 19, duration: 42 * 60 + 57 };
  const before = JSON.stringify(episode);
  assert.equal((await entries([episode])).length, 0);
  assert.equal(JSON.stringify(episode), before);
  assert.equal((await entries([{ ...episode, position: 60 }])).length, 1);
});

test('catalog series completion cannot bring an older episode back, and local movies follow the same cutoff', async () => {
  const latest = { ...movie, kind: 'catalog', catalogRef: { type: 'tv', tmdbId: 42 }, updatedAt: 2 };
  const older = { ...latest, id: 'older', position: 100, updatedAt: 1 };
  assert.equal((await entries([older, latest])).length, 0);
  assert.equal((await entries([{ ...movie, kind: 'file' }])).length, 0);
});
