'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function fixture(preference = { enabled: false }, tracks = [{ languageCode: 'en', displayName: 'English' }, { languageCode: 'es', displayName: 'Spanish' }]) {
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
  const context = vm.createContext({ window, document: { createElement: () => ({}) }, EventTarget, Event, performance, URL, setInterval() {}, setTimeout, clearTimeout });
  const source = fs.readFileSync(path.join(__dirname, '../public/js/media.js'), 'utf8');
  vm.runInContext(source.replace(/^export /gm, '') + '\nglobalThis.Media = YouTubeMedia;', context);
  const media = new context.Media({ appendChild() {}, innerHTML: '' }, { captionPreference: () => preference });
  await media.open({ videoId: 'abcdefghijk' });
  players[0].options.events.onReady();
  return { media, players, preference };
}

test('Watch Party exclusively controls the YouTube player, with local captions Off by default', async () => {
  const { media, players } = await fixture();
  const player = players[0];
  assert.equal(player.options.playerVars.controls, 0);
  assert.equal(player.options.playerVars.disablekb, 1);
  assert.equal(player.options.playerVars.fs, 0);
  assert.equal(media.captionsAvailable, true);
  assert.deepEqual(Array.from(media.captionTracks, t => t.label), ['English', 'Spanish']);
  assert.equal(player.modules.length, 0);
  media.setCaptions(true, 'es');
  assert.equal(media.captionsEnabled, true);
  assert.ok(player.writes.some(([module, option, value]) => module === 'captions' && option === 'track' && value.languageCode === 'es'));
  media.setCaptions(false);
  assert.equal(player.modules.length, 0);
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
  assert.equal(players[1].modules.length, 0);
});

test('videos without caption tracks are distinguished from a player that is still loading captions', async () => {
  const { media, players } = await fixture({}, []);
  assert.equal(media.captionsAvailable, false);
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
  assert.equal(player.modules.length, 0);
  assert.deepEqual(Object.keys(player.track), []);
  assert.equal(media.captionsEnabled, false);
});
