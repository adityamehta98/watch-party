'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('YouTube stays behind the loader until it plays at the room position, and starts with a jump there', () => {
  let now = 10000;
  const context = vm.createContext({ PLATFORM: { device: 'desktop' }, document: { addEventListener() {}, hidden: false }, performance: { now: () => now }, setInterval: () => 0, setTimeout, clearTimeout });
  vm.runInContext(read('public/js/sync.js').replace(/^export /gm, ''), context);
  vm.runInContext(read('public/js/player.js').replace(/^import .*;$/gm, '').replace(/^export /gm, '') + '\nglobalThis.SyncPlayer = SyncPlayer;', context);
  const handlers = {}, seeks = [];
  const media = { isAdapter: true, syncProfile: { hardSeek: 0.5, rate: false, pausedEps: 0.3, settle: true }, currentSrc: 'yt:x', readyState: 4, paused: true, seeking: false, time: 0,
    get currentTime() { return this.time; }, set currentTime(t) { seeks.push(t); this.seeking = true; },
    addEventListener(ev, fn) { (handlers[ev] ||= []).push(fn); }, removeEventListener() {}, open() {}, close() {}, play: () => new Promise(() => {}), pause() {} };
  const emit = ev => (handlers[ev] || []).forEach(fn => fn());
  const player = new context.SyncPlayer({ video: media, clock: { synced: true, now: () => 100000, rtt: 0 }, onStatus() {} });
  player.setMovie({ id: 'm' });
  player.setState({ movieId: 'm', playing: true, position: 0, anchor: 100000, seq: 1 });
  assert.equal(seeks.length, 1, 'the first move is a jump to the room position, even from 0:00');
  assert.ok(seeks[0] <= .25, 'startup compensation must stay inside the 0.5 s correction threshold');
  media.seeking = false; media.paused = false; media.time = 360; emit('playing'); // YouTube resumed at its own remembered spot
  assert.equal(player.syncing, true, 'playing in the wrong place keeps the loader up');
  media.time = 0.2; emit('playing');
  media.playingSince = now; player.correct();
  assert.equal(player.syncing, true, 'one transient playing event must not expose startup jumps');
  now += 1001; player.correct(); assert.equal(player.syncing, true);
  now += 1001; player.correct();
  assert.equal(player.syncing, false);
});
