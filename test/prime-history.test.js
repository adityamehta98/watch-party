'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { cleanPlayback } = require('../server/playback-history');
const { AnimeHistory } = require('../server/anime-history');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const genericTitle = 'Prime Video: Watch movies, TV shows, sports, and live TV';

function frame({ pathname = '/detail/CONTENT1', title = 'A real movie', ad = false, hiddenAd = false, subtitle = '' } = {}) {
  let now = 10000;
  const messages = [], intervals = [];
  const state = { title, ad, hiddenAd, subtitle };
  const video = { duration: 138, currentTime: 12, paused: false, readyState: 4, playbackRate: 1, volume: 1,
    addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ width: 1200, height: 700 }) };
  const location = new URL('https://www.primevideo.com' + pathname);
  const document = { title: genericTitle, addEventListener() {},
    querySelector(selector) { return selector === '.atvwebplayersdk-title-text' && state.title ? { textContent: state.title } : null; },
    querySelectorAll(selector) {
      if (selector === 'video') return [video];
      if (selector.includes('.atvwebplayersdk-adtimeindicator-text')) return state.ad ? [{ textContent: 'Your program resumes in 15 sec', checkVisibility: () => !state.hiddenAd }] : [];
      if (selector === '.atvwebplayersdk-subtitle-text') return [{ textContent: state.subtitle, checkVisibility: () => !state.hiddenSubtitle }];
      return [];
    },
  };
  const window = { addEventListener() {}, postMessage() {} }; window.top = window;
  const context = vm.createContext({ URL, window, document, location, performance: { now: () => now }, Date: { now: () => now },
    setInterval: fn => intervals.push(fn), setTimeout() {}, clearTimeout() {}, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    chrome: { runtime: { sendMessage: async msg => { messages.push(msg); }, onMessage: { addListener() {} } } } });
  vm.runInContext(read('extension/services.js'), context);
  vm.runInContext(read('extension/service-navigation.js'), context);
  vm.runInContext(read('extension/service.js').split('// ------------------------------------------------ the party\'s buttons')[0], context);
  return { video, state, tick() { now += 250; for (const fn of intervals) fn(); return messages.filter(m => m.wp === 'status').at(-1)?.st; } };
}

test('Prime browse previews and the generic landing-page title cannot count as a movie', () => {
  for (const pathname of ['/addons', '/movie', '/detail/CONTENT1']) {
    const f = frame({ pathname, title: '' });
    assert.equal(f.tick().ad, true);
    assert.equal(f.tick().dur, 0);
  }
});

test('a Prime preroll is detected before any content duration is known and does not overwrite midroll progress', () => {
  const f = frame({ ad: true });
  assert.equal(f.tick().ad, true);
  f.state.ad = false; f.video.duration = 1800; f.video.currentTime = 125;
  const content = f.tick(); assert.equal(content.ad, false); assert.equal(content.t, 125);
  f.state.ad = true; f.video.duration = 15; f.video.currentTime = 2;
  const midroll = f.tick(); assert.equal(midroll.ad, true); assert.equal(midroll.t, 125); assert.equal(midroll.dur, 1800);
});

test('hidden Prime ad controls do not suppress a genuine short title, while an explicit trailer does', () => {
  const f = frame({ ad: true, hiddenAd: true }); f.video.duration = 84;
  assert.equal(f.tick().ad, false);
  f.state.subtitle = 'Season 1 Trailer';
  assert.equal(f.tick().ad, true);
  f.state.hiddenSubtitle = true;
  assert.equal(f.tick().ad, false);
});

test('server history rejects Prime ads and previews without rejecting genuinely short named content', () => {
  const entry = { id: 'prime1', kind: 'service', service: 'prime', url: 'https://www.primevideo.com/detail/CONTENT1', position: 3, duration: 84, title: 'A short film' };
  assert.ok(cleanPlayback(entry));
  assert.equal(cleanPlayback({ ...entry, ad: true }), null);
  assert.equal(cleanPlayback({ ...entry, preview: true }), null);
  assert.equal(cleanPlayback({ ...entry, title: genericTitle }), null);
  for (const page of ['addons', 'movie']) assert.equal(cleanPlayback({ ...entry, url: 'https://www.primevideo.com/' + page }), null);
});

test('loading saved history removes the reported false Prime rows and preserves real titles and timestamps', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-prime-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'watch-history.json');
  const real = { id: 'real', kind: 'service', service: 'prime', title: 'A real short film', url: 'https://www.primevideo.com/detail/REAL1', position: 12, duration: 84, updatedAt: 123 };
  const wrong = ['addons', 'movie', 'detail/AD1'].map((page, i) => ({ ...real, id: 'ad' + i, title: genericTitle, url: 'https://www.primevideo.com/' + page }));
  fs.writeFileSync(file, JSON.stringify({ version: 3, episodes: [], playback: [real, ...wrong] }));
  const history = new AnimeHistory(file);
  assert.deepEqual(history.playbackList().map(e => e.id), ['real']);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')).playback;
  assert.equal(saved.length, 1); assert.equal(saved[0].position, 12); assert.equal(saved[0].updatedAt, 123);
});
