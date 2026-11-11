'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanNetflixMetadata, fetchNetflixMetadata, parseNetflixTitle } = require('../server/netflix-metadata');

const poster = 'https://occ-1.nflxso.net/dnm/api/v6/official.jpg?r=6b3';
function page(field = 'data', { complete = false, secondSeason = false } = {}) {
  const show = { __typename: 'Show', videoId: 81772075, title: 'Akka', seasons: { edges: [{ node: {
    title: 'Season 1', episodes: { edges: [
      { node: { videoId: 82006998, number: 1, title: 'The Sisterhood' } },
      { node: { videoId: 82006999, number: 2, title: 'Wounds and Scars' } },
    ] },
  } }] } };
  if (secondSeason) show.seasons.edges.unshift({ node: { title: 'Season 2', episodes: { edges: [
    { node: { videoId: 82008001, number: 1, title: 'New season' } },
  ] } } });
  if (complete) {
    show.seasons.totalCount = show.seasons.edges.length;
    show.seasons.pageInfo = { hasNextPage: false };
    for (const edge of show.seasons.edges) edge.node.episodes.pageInfo = { hasNextPage: false };
  }
  const context = { models: { graphqlClcs: { data: { result: { clcsHookV2: { result: { screen: {
    componentTree: { nodes: [{ [field]: { videos: [show] } }] },
  } } } } } } } };
  return `<script type="application/ld+json">${JSON.stringify({ '@type': 'TVSeries', url: 'https://www.netflix.com/title/81772075', name: 'Akka', image: poster })}</script>
    <script>netflix.reactContext = ${JSON.stringify(context).replaceAll('The Sisterhood', 'The\\x20Sisterhood')};</script>`;
}

test('official title pages match the watched episode ID and use the show artwork', () => {
  assert.deepEqual(parseNetflixTitle(page(), '81772075', '82006998'), { title: 'Akka', seriesId: '81772075', poster, episode: 1, episodeTitle: 'The Sisterhood', season: 1 });
  assert.equal(parseNetflixTitle(page(), '81772075', '82006999').episode, 2);
  assert.equal(parseNetflixTitle(page(), '81772075', '00000000'), null);
  assert.equal(parseNetflixTitle(page(), '11111111', '82006998'), null);
});

test('Netflix component variants still resolve artwork and collect every verified episode identity', () => {
  for (const field of ['data', 'webLoggedOutDetailPage_data']) {
    const episodes = new Map();
    const result = parseNetflixTitle(page(field), '81772075', '82006999', (id, metadata) => episodes.set(id, metadata));
    assert.equal(result.poster, poster);
    assert.equal(result.seriesId, '81772075');
    assert.equal(result.episode, 2);
    assert.equal(episodes.get('82006998').episode, 1);
    assert.equal(episodes.get('82006998').poster, result.poster);
  }
});

test('the shelf shows only the last watched episode, even if it has a lower episode number', async () => {
  const { playbackResumeEntries } = await import('../public/js/playback-resume.js');
  const first = { id: 'ep1', service: 'netflix', position: 50, duration: 1000, updatedAt: 10, netflix: { seriesId: '123', title: 'Same name', episode: 1 } };
  const fifth = { ...first, id: 'ep5', updatedAt: 20, netflix: { ...first.netflix, episode: 5 } };
  const other = { ...first, id: 'other', netflix: { ...first.netflix, seriesId: '456' } };
  assert.deepEqual(playbackResumeEntries([first, fifth, other]).map(e => e.id), ['ep5', 'other']);
  assert.deepEqual(playbackResumeEntries([{ ...first, updatedAt: 30 }, fifth]).map(e => e.id), ['ep1']);
  assert.equal(playbackResumeEntries([first, { ...fifth, hidden: true }]).length, 0);
  assert.equal(playbackResumeEntries([first, { ...fifth, position: 999 }]).length, 0);
});

test('the final episode is verified across all seasons, never from an incomplete page', () => {
  const last = parseNetflixTitle(page('data', { complete: true }), '81772075', '82006999');
  assert.equal(last.finalEpisode, true);
  assert.equal(cleanNetflixMetadata(last).finalEpisode, true);
  assert.equal(parseNetflixTitle(page('data', { complete: true }), '81772075', '82006998').finalEpisode, false);
  assert.equal(parseNetflixTitle(page(), '81772075', '82006999').finalEpisode, undefined);
  const paginated = page('data', { complete: true }).replace('"hasNextPage":false', '"hasNextPage":true');
  assert.equal(parseNetflixTitle(paginated, '81772075', '82006999').finalEpisode, undefined);
});

test('a later available season prevents the previous season finale from completing the series', () => {
  const html = page('webLoggedOutDetailPage_data', { complete: true, secondSeason: true });
  assert.equal(parseNetflixTitle(html, '81772075', '82006999').finalEpisode, false);
  assert.equal(parseNetflixTitle(html, '81772075', '82008001').finalEpisode, true);
});

test('Netflix episodes hide within five minutes without exposing older episodes or requiring finale metadata', async () => {
  const { playbackResumeEntries } = await import('../public/js/playback-resume.js');
  const final = { id: 'final', service: 'netflix', position: 2100, duration: 2400, updatedAt: 20,
    netflix: { seriesId: '123', title: 'Series', episode: 5, finalEpisode: true } };
  const prior = { ...final, id: 'prior', updatedAt: 10, netflix: { ...final.netflix, episode: 4, finalEpisode: false } };
  assert.equal(playbackResumeEntries([prior, final]).length, 0);
  assert.equal(playbackResumeEntries([prior, { ...final, position: 2099 }])[0].id, 'final');
  for (const finalEpisode of [undefined, false]) {
    assert.equal(playbackResumeEntries([{ ...final, netflix: { ...final.netflix, finalEpisode } }]).length, 0);
  }
  assert.equal(playbackResumeEntries([{ ...final, position: 50, duration: 240 }]).length, 1, 'do not mark a short episode finished near its start');
  assert.equal(final.position, 2100, 'shelf filtering preserves saved progress');
});

test('Netflix movies get artwork without an episode number', () => {
  const html = `<script type="application/ld+json">${JSON.stringify({ '@type': 'Movie', url: 'https://www.netflix.com/title/12345', name: 'A Movie', image: poster })}</script>`;
  assert.deepEqual(parseNetflixTitle(html, '12345', '12345'), { title: 'A Movie', poster, episode: null, episodeTitle: '', season: null });
});

test('metadata lookup follows only public Netflix title redirects and discards tracking data', async () => {
  const calls = [];
  const result = await fetchNetflixMetadata('https://www.netflix.com/watch/82006999?trackId=private', { request: async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.cookie, undefined);
    return calls.length === 1 ? Response.redirect('https://www.netflix.com/in/title/81772075?track=discard') : new Response(page());
  } });
  assert.equal(result.episode, 2);
  assert.deepEqual(calls, ['https://www.netflix.com/title/82006999', 'https://www.netflix.com/in/title/81772075']);
  let redirects = 0;
  const blocked = await fetchNetflixMetadata('https://www.netflix.com/watch/82006999', { request: async () => {
    redirects++; return Response.redirect('https://www.netflix.com.evil.example/title/81772075');
  } });
  assert.equal(blocked, null);
  assert.equal(redirects, 1);
  for (const value of ['http://occ-1.nflxso.net/dnm/api/evil.jpg', 'https://evil.example/dnm/api/evil.jpg', 'https://u:p@occ-1.nflxso.net/dnm/api/evil.jpg']) {
    assert.equal(cleanNetflixMetadata({ title: 'Akka', poster: value }).poster, '');
  }
  assert.equal(cleanNetflixMetadata({ title: 'Akka', poster: `${poster}&secret=hidden#data` }).poster, poster);
});

test('Continue watching renders the show, episode, artwork, and original resume time', async () => {
  const { playbackResumeCard } = await import('../public/js/playback-resume.js');
  const html = playbackResumeCard({ service: 'netflix', id: 'oldid', title: 'AkkaE1The Sisterhood', position: 899, duration: 2797,
    netflix: parseNetflixTitle(page(), '81772075', '82006998') }, true);
  assert.match(html, /<strong>Akka<\/strong>/);
  assert.match(html, /Ep 1 — The Sisterhood/);
  assert.match(html, /class="playback-resume-poster".*official\.jpg/);
  assert.match(html, /Resume at 14:59 \/ 46:37/);
  assert.match(html, /data-playback-play="oldid"/);
  assert.doesNotMatch(html, /AkkaE1The/);
});
