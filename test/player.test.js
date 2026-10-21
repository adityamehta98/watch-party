'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = name => fs.readFileSync(path.join(__dirname, '../public/js', name), 'utf8');
const moduleOf = name => import(`data:text/javascript;base64,${Buffer.from(read(name)).toString('base64')}`);

class Events {
  constructor() { this.listeners = new Map(); }
  addEventListener(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
  }
  removeEventListener(event, fn) { this.listeners.get(event)?.delete(fn); }
  emit(event, data = {}) { for (const fn of this.listeners.get(event) || []) fn(data); }
}

async function playerFixture() {
  const { syncTuning, APPLE_PROFILE } = await moduleOf('sync.js');
  let now = 10000;
  const timers = new Map();
  let timerId = 0;
  const context = vm.createContext({
    PLATFORM: { appleMobile: true, device: 'iPad' }, syncTuning, APPLE_PROFILE,
    document: new Events(), performance: { now: () => now },
    setInterval() {}, setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(read('player.js').replace(/^import .*;$/gm, '').replace(/export /g, '') + '\nglobalThis.Player = SyncPlayer;', context);
  const video = new Events();
  let time = 0;
  Object.assign(video, {
    currentSrc: '/episode.m3u8', readyState: 4, paused: true, seeking: false,
    playbackRate: 1, muted: false, seeks: [], pauses: 0, plays: 0,
    buffered: { length: 1, start: () => 0, end: () => 1000 },
    querySelectorAll: () => [], load() {}, removeAttribute() {},
    pause() { this.pauses++; this.paused = true; },
    play() { this.plays++; this.paused = false; return Promise.resolve(); },
  });
  Object.defineProperty(video, 'currentTime', {
    get: () => time,
    set(value) { time = value; this.seeks.push(value); this.seeking = true; this.emit('seeking'); },
  });
  let rate = 1;
  video.rateWrites = [];
  Object.defineProperty(video, 'playbackRate', {
    get: () => rate,
    set(value) { rate = value; this.rateWrites.push(value); },
  });
  const clock = { synced: true, now: () => now, rtt: 100 };
  const player = new context.Player({ video, clock, onStatus() {}, onChange() {} });
  player.setMovie({ id: 'ep1', hls: '/episode.m3u8' });
  return {
    video, player, timers,
    advance(ms, playing = true) { now += ms; if (playing && !video.paused && !video.seeking) time += ms / 1000 * video.playbackRate; },
    finishSeek() { video.seeking = false; video.emit('seeked'); },
    time(value) { time = value; },
    state(patch = {}) { player.setState({ movieId: 'ep1', playing: true, position: 100, anchor: now, seq: 1, ...patch }); },
  };
}

test('iPad HLS seeks resume without repeated pause/seek cycles', async () => {
  const f = await playerFixture();
  f.state();
  assert.equal(f.video.seeks.length, 1);
  assert.equal(f.video.plays, 1, 'play must run even when the initial correction seeks');
  assert.equal(f.video.pauses, 0);
  assert.ok(f.video.seeks[0] < 100.9, 'latency compensation must fit inside the Apple threshold');
  f.advance(1200, false);
  f.finishSeek();
  for (let i = 0; i < 4; i++) { f.advance(200); f.player.correct(); }
  assert.equal(f.video.seeks.length, 1, 'decoder gets time to settle');
  f.advance(400); f.player.correct();
  assert.equal(f.video.seeks.length, 1, 'seek latency inside the tolerance must not restart playback');
  for (let i = 0; i < 15; i++) { f.advance(200); f.player.correct(); }
  assert.equal(f.video.seeks.length, 1, 'playback continues after the correction');
  assert.equal(f.video.pauses, 0);
});

test('buffering after a seek is not restarted every sync tick', async () => {
  const f = await playerFixture();
  f.state(); f.finishSeek(); f.video.readyState = 2;
  for (let i = 0; i < 30; i++) { f.advance(200, false); f.player.correct(); }
  assert.equal(f.video.seeks.length, 1);
  f.state({ position: 300, seq: 2 });
  assert.equal(f.video.seeks.length, 2, 'a new user seek takes effect during recovery');
  assert.ok(f.video.seeks[1] >= 300);
});

test('continuous iPad playback never adjusts speed or seeks for small timestamp jitter', async () => {
  const f = await playerFixture();
  f.time(100); f.video.paused = false; f.state();
  for (let i = 0; i < 300; i++) {
    f.advance(200);
    f.time(f.player.expected() + (i % 2 ? 0.4 : -0.6));
    f.player.correct();
  }
  assert.equal(f.video.seeks.length, 0);
  assert.equal(f.video.pauses, 0);
  assert.equal(f.video.rateWrites.length, 0, 'normal viewing must not touch the Apple playback rate');
});

test('iPad drift must persist before a correction and cannot trigger another seek every second', async () => {
  const f = await playerFixture();
  f.time(100); f.video.paused = false; f.state();
  f.time(97); f.player.correct();
  for (let i = 0; i < 9; i++) { f.advance(200); f.player.correct(); }
  assert.equal(f.video.seeks.length, 0, 'transient drift is allowed to recover');
  f.advance(200); f.player.correct();
  assert.equal(f.video.seeks.length, 1);
  f.finishSeek(); f.time(f.player.expected() - 3);
  for (let i = 0; i < 45; i++) { f.advance(200); f.player.correct(); }
  assert.equal(f.video.seeks.length, 1, 'a decoder lag must not cause a seek loop');
  f.state({ position: 200, seq: 2 });
  assert.equal(f.video.seeks.length, 2, 'an explicit user seek bypasses the drift cooldown');
});

test('iPad anime and catalog streams use native HLS before ManagedMediaSource', async () => {
  const { deliverySources } = await moduleOf('capabilities.js');
  for (const kind of ['anime', 'catalog', 'file']) {
    const sources = deliverySources({ kind, hls: '/stream.m3u8' }, { hls: true, mse: true, nativeHlsPreferred: true }, 'key');
    assert.equal(sources[0].type, 'native-hls');
    assert.equal(sources[1].type, 'hls-js');
  }
});

test('play starts while a seek recovers and duplicate state echoes keep recovery intact', async () => {
  const f = await playerFixture();
  f.state(); f.finishSeek();
  await new Promise(resolve => setImmediate(resolve));
  f.video.paused = true;
  f.advance(200, false);
  f.player.setState({ ...f.player.state, seq: 2 });
  assert.equal(f.video.plays, 2);
  assert.equal(f.video.seeks.length, 1);
});

test('episode changes ignore the previous timeline and clear stale play promises', async () => {
  const f = await playerFixture();
  let rejectOld;
  f.video.play = () => new Promise((_resolve, reject) => { rejectOld = reject; });
  f.state();
  f.player.setMovie({ id: 'ep2', hls: '/episode2.m3u8' });
  f.time(0); f.video.seeking = false;
  f.player.correct();
  assert.equal(f.video.seeks.length, 1, 'old episode state must not seek the new episode');
  f.video.play = () => Promise.resolve();
  f.state({ movieId: 'ep2', position: 0, seq: 2 });
  rejectOld({ name: 'NotAllowedError' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.video.muted, false);
  assert.equal(f.player.playPending, false);
});

test('new state cancels a scheduled play before its timer can restart paused video', async () => {
  const f = await playerFixture();
  f.time(100);
  f.state({ anchor: 11000 });
  assert.equal(f.timers.size, 1);
  f.state({ playing: false, seq: 2 });
  assert.equal(f.timers.size, 0);
  assert.equal(f.video.plays, 0);
});

function stageFixture() {
  const doc = new Events(), classes = new Set();
  const stage = { ownerDocument: doc, classList: {
    contains: c => classes.has(c), add: c => classes.add(c), remove: c => classes.delete(c),
    toggle(c, on) { if (on) classes.add(c); else classes.delete(c); },
  } };
  return { doc, stage };
}

test('unsupported fullscreen reports the limit and only expands the page when explicitly chosen', async () => {
  const { StageFullscreen } = await moduleOf('fullscreen.js');
  for (const rejected of [false, true]) {
    const { doc, stage } = stageFixture();
    if (rejected) stage.requestFullscreen = () => Promise.reject(new Error('denied'));
    let unavailable = 0;
    const fullscreen = new StageFullscreen(stage, () => {}, { onUnavailable: () => unavailable++ });
    await fullscreen.toggle();
    assert.equal(unavailable, 1);
    assert.equal(fullscreen.active, false, 'page expansion must not be passed off as fullscreen');
    fullscreen.expandPage();
    assert.equal(fullscreen.active, true);
    assert.equal(stage.classList.contains('page-fullscreen'), true);
    assert.equal(stage.classList.contains('is-fs'), true);
    await fullscreen.toggle(); assert.equal(fullscreen.active, false);
    fullscreen.expandPage(); doc.emit('keydown', { key: 'Escape' });
    assert.equal(fullscreen.active, false);
  }
  assert.doesNotMatch(read('app.js'), /video\.webkitEnterFullscreen/);
});

test('Brave video-only fullscreen shim cannot hijack the Watch Party stage', async () => {
  const { StageFullscreen } = await moduleOf('fullscreen.js');
  const { doc, stage } = stageFixture();
  let nativePlayerCalls = 0, unavailable = 0;
  class BrowserDocument {}
  Object.defineProperty(BrowserDocument.prototype, 'fullscreenEnabled', { get: () => false });
  doc.defaultView = { Document: BrowserDocument };
  doc.fullscreenEnabled = true;
  stage.requestFullscreen = () => { nativePlayerCalls++; return true; };
  const fullscreen = new StageFullscreen(stage, () => {}, { onUnavailable: () => unavailable++ });
  await fullscreen.toggle();
  assert.equal(nativePlayerCalls, 0);
  assert.equal(fullscreen.active, false);
  assert.equal(unavailable, 1);
});

test('a fullscreen shim returning success without fullscreen state is not accepted', async () => {
  const { StageFullscreen } = await moduleOf('fullscreen.js');
  const { stage } = stageFixture();
  let unavailable = 0;
  stage.requestFullscreen = () => true;
  const fullscreen = new StageFullscreen(stage, () => {}, { onUnavailable: () => unavailable++ });
  await fullscreen.toggle();
  assert.equal(fullscreen.active, false);
  assert.equal(unavailable, 1);
});

test('standard and WebKit fullscreen target the whole stage and track browser exits', async () => {
  const { StageFullscreen } = await moduleOf('fullscreen.js');
  for (const webkit of [false, true]) {
    const { doc, stage } = stageFixture();
    const prop = webkit ? 'webkitFullscreenElement' : 'fullscreenElement';
    const event = webkit ? 'webkitfullscreenchange' : 'fullscreenchange';
    stage[webkit ? 'webkitRequestFullscreen' : 'requestFullscreen'] = () => { doc[prop] = stage; doc.emit(event); };
    doc[webkit ? 'webkitExitFullscreen' : 'exitFullscreen'] = () => { doc[prop] = null; doc.emit(event); };
    const fullscreen = new StageFullscreen(stage);
    await fullscreen.toggle();
    assert.equal(fullscreen.active, true);
    assert.equal(fullscreen.pageMode, false);
    await fullscreen.toggle(); assert.equal(fullscreen.active, false);
    await fullscreen.toggle(); doc[prop] = null; doc.emit(event);
    assert.equal(stage.classList.contains('is-fs'), false);
  }
});

test('asynchronous WebKit fullscreen waits for the browser transition', async () => {
  const { StageFullscreen } = await moduleOf('fullscreen.js');
  const { doc, stage } = stageFixture();
  let unavailable = 0;
  stage.webkitRequestFullscreen = () => {
    setTimeout(() => { doc.webkitFullscreenElement = stage; doc.emit('webkitfullscreenchange'); }, 20);
  };
  const fullscreen = new StageFullscreen(stage, () => {}, { onUnavailable: () => unavailable++ });
  await fullscreen.toggle();
  assert.equal(fullscreen.active, true);
  assert.equal(unavailable, 0);
});
