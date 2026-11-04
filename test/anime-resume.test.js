'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const moduleOf = async () => import(`data:text/javascript;base64,${Buffer.from(fs.readFileSync(path.join(__dirname, '../public/js/anime-resume.js'), 'utf8')).toString('base64')}`);
const episode = { anilistId: 151801, animeTitle: 'Mashle', episode: 3, episodes: 12, position: 360, duration: 1440, language: 'dub', poster: 'https://s4.anilist.co/mashle.jpg' };

test('resume card shows the saved episode, cover, elapsed/total time, and a proportional progress bar', async () => {
  const { animeResumeCard } = await moduleOf();
  const card = animeResumeCard(episode);
  assert.match(card, /src="https:\/\/s4.anilist.co\/mashle.jpg"/);
  assert.match(card, /data-episode="3"/);
  assert.match(card, /Stopped at 6:00/);
  assert.match(card, /6:00 \/ 24:00/);
  assert.match(card, /aria-valuenow="25.0"/);
  assert.match(card, /width:25.000%/);
  assert.match(card, /data-history-dismiss="151801"/);
  assert.match(card, /aria-label="Remove Mashle from Continue watching"/);
  assert.doesNotMatch(card, /anime-resume-badge|anime-resume-meta|anime-resume-time|anime-resume-title/);
});

test('unknown durations do not claim a percentage and progress stays within the track', async () => {
  const { animeResumeCard } = await moduleOf();
  const unknown = animeResumeCard({ ...episode, duration: 0 });
  assert.doesNotMatch(unknown, /aria-valuenow=/);
  assert.match(unknown, /6:00 watched/);
  assert.match(unknown, /width:0.000%/);
  assert.match(animeResumeCard({ ...episode, position: 2000 }), /width:100.000%/);
  assert.match(animeResumeCard({ ...episode, position: -1 }), /width:0.000%/);
});

test('shared guest cards can resume without exposing the host-only dismiss action', async () => {
  const { animeResumeCard } = await moduleOf();
  const card = animeResumeCard({ ...episode, canDismiss: false });
  assert.match(card, /data-history-play="151801"/);
  assert.doesNotMatch(card, /data-history-dismiss=/);
});

test('only a known final episode near its end leaves Continue watching', async()=>{
 const {animeSeriesFinished}=await moduleOf();
 const entry={...episode,episode:12,episodes:12,position:1140,duration:1440};
 assert.equal(animeSeriesFinished([entry]),true);
 assert.equal(animeSeriesFinished([{...entry,position:1139}]),false);
 assert.equal(animeSeriesFinished([{...entry,episode:11}]),false);
 assert.equal(animeSeriesFinished([{...entry,episodes:0}]),false);
 assert.equal(animeSeriesFinished([{...entry,position:0}]),false);
 assert.equal(animeSeriesFinished([{...entry,duration:0}]),false);
 assert.equal(animeSeriesFinished([{...entry,episode:1},entry]),false,'a replayed earlier episode is still resumable');
 assert.equal(animeSeriesFinished([{...entry,duration:120,position:1}]),false,'short episodes must not vanish immediately');
 assert.equal(animeSeriesFinished([{...entry,duration:120,position:100}]),true);
 assert.equal(animeSeriesFinished([{...entry,episodes:0},{...entry,episode:11}]),true,'known series length is retained from older history');
});
