'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function navigation() {
  const elements = Object.fromEntries(['#animeEpisodePicker', '#animeEpisodeSelect', '#animeEpisodeSelectInline'].map(id => [id, {
    hidden: true, innerHTML: '', value: '', listeners: {}, addEventListener(name, callback) { this.listeners[name] = callback; },
  }]));
  const S = { movie: { kind: 'anime', id: 'ep4', anilistId: 123, malId: 456, episode: 4, episodes: 13, language: 'dub', animeTitle: 'Series' },
    animeHistory: [{ anilistId: 123, episode: 2, completed: true, position: 1400 }, { anilistId: 123, episode: 4, position: 522 }] };
  const picks = [];
  const document = { activeElement: null };
  const context = vm.createContext({ S, document, $: id => elements[id], kindOf: movie => movie?.kind,
    fmtTime: seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`,
    selectAnime: message => picks.push(JSON.parse(JSON.stringify(message))) });
  const app = require('./app-source');
  vm.runInContext(app.slice(app.indexOf("let episodePickerKey = ''"), app.indexOf('function renderAnimeOverlay()')), context);
  return { S, elements, picks, document, render: () => context.renderAnimeEpisodePicker(), choose: ep => context.chooseAnimeEpisode(ep) };
}

test('header and fullscreen pickers show the series episodes and shared watch markers', () => {
  const f = navigation(); f.render();
  const header = f.elements['#animeEpisodeSelect'], fullscreen = f.elements['#animeEpisodeSelectInline'];
  assert.equal((header.innerHTML.match(/<option/g) || []).length, 13);
  assert.match(header.innerHTML, /Ep 2 · Watched/);
  assert.match(header.innerHTML, /Ep 4 · 8:42/);
  assert.equal(header.value, '4');
  assert.equal(header.innerHTML, fullscreen.innerHTML);
  assert.equal(fullscreen.value, '4');
  f.S.movie = null; f.render();
  assert.equal(f.elements['#animeEpisodePicker'].hidden, true);
  assert.equal(fullscreen.hidden, true);
});

test('episode selection preserves series and language while rejecting bounds and the current episode', () => {
  const f = navigation();
  for (const episode of [0, -1, 14, 4, 2.5, NaN]) f.choose(episode);
  assert.equal(f.picks.length, 0);
  f.elements['#animeEpisodeSelect'].listeners.change({ target: { value: '7' } });
  assert.deepEqual(f.picks[0], { anilistId: 123, malId: 456, ep: 7, episodes: 13, lang: 'dub', title: 'Series', resume: true });
});

test('progress updates leave an open episode picker intact while a new selection still refreshes it', () => {
  const f = navigation(); f.render();
  const header = f.elements['#animeEpisodeSelect'], previous = header.innerHTML;
  f.document.activeElement = header;
  f.S.animeHistory[1].position = 600;
  f.render();
  assert.equal(header.innerHTML, previous);
  f.S.movie = { ...f.S.movie, id: 'ep5', episode: 5 };
  f.render();
  assert.equal(header.value, '5');
});
