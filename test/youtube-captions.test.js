'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function fixture(preference = { enabled: false }, tracks = [{ languageCode: 'en', displayName: 'English' }, { languageCode: 'es', displayName: 'Spanish' }], extras = {}) {
  const players = [];
  const window = { YT: { Player: class {
    constructor(host, options) { this.options = options; this.modules = ['captions']; this.writes = []; this.time = 123; this.paused = true; players.push(this); }
    setVolume() {}
    getOptions() { return this.modules; }
    getOption(module, option) { return option === 'tracklist' ? tracks : this.track || null; }
    setOption(...args) { this.writes.push(args); if (args[1] === 'track') this.track = args[2]; }
    unloadModule(name) { this.modules = this.modules.filter(m => m !== name); this.writes.push(['unload', name]); }
    loadModule(name) { this.modules = [name]; this.options.events.onApiChange(); }
    destroy() { this.destroyed = true; }
    pauseVideo() { this.paused = true; }
    playVideo() { this.paused = false; this.options.events.onStateChange({ data: 1 }); }
    getDuration() { return 900; }
    getCurrentTime() { return this.time; }
    seekTo(t) { this.time = t; }
  } } };
  if (extras.fetch) window.fetch = extras.fetch;
  const context = vm.createContext({ window, AbortSignal: extras.AbortSignal, document: { createElement: () => ({}) }, EventTarget, Event, performance: extras.performance || performance, URL, setInterval() {}, setTimeout: extras.setTimeout || setTimeout, clearTimeout });
  const source = fs.readFileSync(path.join(__dirname, '../public/js/media.js'), 'utf8');
  vm.runInContext(source.replace(/^export /gm, '') + '\nglobalThis.Media = YouTubeMedia;', context);
  const media = new context.Media({ appendChild() {}, innerHTML: '' }, { captionPreference: () => preference });
  await media.open({ videoId: 'abcdefghijk' }, extras.startAt);
  players[0].options.events.onReady();
  return { media, players, preference };
}

test('Watch Party exclusively controls the YouTube player, with local captions Off by default', async () => {
  const { media, players } = await fixture();
  const player = players[0];
  assert.equal(player.options.playerVars.controls, 0, 'native center play/pause controls must not linger over normal playback');
  assert.equal(player.options.playerVars.disablekb, 1);
  assert.equal(player.options.playerVars.fs, 0);
  assert.equal(media.captionsAvailable, true);
  assert.deepEqual(Array.from(media.captionTracks, t => t.label), ['English', 'Spanish']);
  assert.deepEqual(Object.keys(player.track), []);
  media.setCaptions(true, 'es');
  assert.equal(media.captionsEnabled, true);
  assert.ok(player.writes.some(([module, option, value]) => module === 'captions' && option === 'track' && value.languageCode === 'es'));
  media.setCaptions(false);
  assert.deepEqual(Object.keys(player.track), []);
  assert.equal(player.time, 123, 'captions never reload or seek the video');
  assert.equal(player.paused, true, 'captions never change playback state');
  await media.play(); assert.equal(player.paused, false);
  media.pause(); assert.equal(player.paused, true);
  media.currentTime = 250; assert.equal(player.time, 250);
});

test('YouTube caption preference survives switching videos and ignores callbacks from a destroyed player', async () => {
  const { media, players, preference } = await fixture({ enabled: true, language: 'es' });
  assert.equal(media.captionsEnabled, true);
  assert.equal(players[0].options.playerVars.cc_lang_pref, 'es');
  preference.enabled = false;
  await media.open({ videoId: 'nextvideo12' });
  const previous = players[0];
  previous.options.events.onApiChange(); previous.options.events.onStateChange({ data: 1 });
  assert.equal(media.ready, false);
  assert.equal(media.state, -1);
  players[1].options.events.onReady();
  assert.equal(media.captionsEnabled, false);
  assert.deepEqual(Object.keys(players[1].track), []);
});

test('an empty iframe tracklist cannot prove that an ASR-only video has no captions', async () => {
  const { media, players } = await fixture({}, []);
  assert.equal(media.captionsAvailable, null);
  assert.equal(media.captionTracks.length, 0);
  await media.open({ videoId: 'nextvideo12' });
  players[1].modules = [];
  players[1].options.events.onReady();
  assert.equal(media.captionsAvailable, null);
  players[0].options.events.onError({ data: 100 });
  assert.equal(media.error, null);
});

test('Off clears captions that YouTube restores when recreating its module', async () => {
  const { media, players } = await fixture();
  const player = players[0];
  player.modules = ['captions']; player.track = { languageCode: 'en' };
  player.options.events.onApiChange();
  assert.deepEqual(Object.keys(player.track), []);
  assert.equal(media.captionsEnabled, false);
});

test('auto-generated captions count as available and can be switched back on after Off', async () => {
  const { media, players } = await fixture({}, []);
  const player = players[0];
  player.track = { languageCode: 'en', kind: 'asr' }; // not in the track list, only the active track
  player.options.events.onApiChange();
  assert.equal(media.captionsAvailable, true);
  assert.deepEqual(Object.keys(player.track), [], 'Off by default');
  assert.deepEqual(player.modules, ['captions'], 'the module stays loaded, or the captions never return');
  media.setCaptions(true);
  assert.equal(player.track.languageCode, 'en');
});

test('YouTube completion emits once and reports the final timestamp even if its API clock resets', async () => {
  const { media, players } = await fixture();
  let ended = 0; media.addEventListener('ended', () => ended++);
  players[0].time = 0;
  players[0].options.events.onStateChange({ data: 0 });
  players[0].options.events.onStateChange({ data: 0 });
  assert.equal(ended, 1); assert.equal(media.ended, true); assert.equal(media.currentTime, 900);
  players[0].options.events.onStateChange({ data: 1 });
  assert.equal(media.ended, false);
});

test('metadata adds translation choices for ASR-only videos and Hindi retains the English ASR source', async () => {
  const { media, players } = await fixture({}, []);
  media.loadCaptionMetadata = async () => ({ tracks: [{ languageCode: 'en', displayName: 'English (auto-generated)', kind: 'asr', vssId: 'a.en', isTranslatable: true }], translations: [{ languageCode: 'hi', displayName: 'Hindi' }] });
  await media.refreshCaptionMetadata();
  assert.equal(media.captionsAvailable, true);
  assert.deepEqual(Array.from(media.captionTracks, t => t.label), ['English (auto-generated)', 'Hindi (auto-translated)']);
  media.setCaptions(true, 'hi');
  assert.equal(players[0].track.languageCode, 'en'); assert.equal(players[0].track.kind, 'asr');
  assert.equal(players[0].track.translationLanguage.languageCode, 'hi');
  media.setCaptions(false);
  assert.deepEqual(Object.keys(players[0].track), []);
  media.setCaptions(true, 'hi');
  assert.equal(players[0].track.translationLanguage.languageCode, 'hi');
  assert.equal(players[0].time, 123); assert.equal(players[0].paused, true);
});

test('late caption metadata cannot replace a newer video and metadata errors remain retryable', async () => {
  const { media } = await fixture({}, []);
  let release;
  media.loadCaptionMetadata = () => new Promise(resolve => { release = resolve; });
  const pending = media.refreshCaptionMetadata();
  media.close();
  release({ tracks: [{ languageCode: 'hi' }], translations: [] }); await pending;
  assert.equal(media.captionTracks.length, 0);
  media.loadCaptionMetadata = async () => { throw Error('Temporary lookup failure'); };
  await media.refreshCaptionMetadata(); assert.match(media.captionError, /Temporary/);
  media.loadCaptionMetadata = async () => ({ tracks: [], translations: [] });
  await media.refreshCaptionMetadata(); assert.equal(media.captionsAvailable, false); assert.equal(media.captionError, '');
});

test('the crop lookup is bounded and a timed-out oEmbed lookup applies the safety fallback', async () => {
  let timeout;
  const { media } = await fixture({}, [], { AbortSignal: { timeout(ms) { timeout = ms; return { testSignal: true }; } }, fetch: async (_, options) => { assert.equal(options.signal.testSignal, true); throw Error('timeout'); } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(timeout, 5000); assert.equal(media.aspect, 16 / 9);
});

test('YouTube initializes at the saved room position and waits for its matching state', async () => {
  let position = null;
  const pending = fixture({}, [], { startAt: () => position });
  setTimeout(() => { position = 3725.4; }, 30);
  const { media, players } = await pending;
  assert.equal(players[0].options.playerVars.start, 3725);
  media.currentTime = 3725;
  players[0].time = 0; players[0].options.events.onStateChange({ data: 1 });
  assert.equal(media.seeking, true, 'an old playing callback must not complete the resume seek');
  players[0].time = 3725; media.tick(); assert.equal(media.seeking, false);
});

test('slow YouTube startup is not mistaken for browser autoplay denial', async () => {
  let now = 0; const timers = [];
  const { media, players } = await fixture({}, [], { performance: { now: () => now }, setTimeout: fn => timers.push(fn) });
  players[0].playVideo = () => {};
  const loading = media.play(); now = 2000; timers.shift()();
  assert.equal(media.autoplayBlocked, false); assert.equal(timers.length, 1);
  now = 10001; timers.shift()(); await assert.rejects(loading, { name: 'TimeoutError' });
  const blocked = media.play(); players[0].options.events.onAutoplayBlocked(); timers.shift()();
  await assert.rejects(blocked, { name: 'NotAllowedError' });
});

test('native controls exist only while quality settings are open and preserve the playhead', async () => {
  const { media, players } = await fixture();
  players[0].time = 3725;
  await media.setNativeControls(true);
  assert.equal(players[0].destroyed, true);
  assert.equal(players[1].options.playerVars.controls, 1);
  assert.equal(players[1].options.playerVars.start, 3725);
  players[1].options.events.onReady(); players[1].time = 3726;
  await media.setNativeControls(false);
  assert.equal(players[2].options.playerVars.controls, 0);
  assert.equal(players[2].options.playerVars.start, 3726);
});
