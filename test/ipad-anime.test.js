'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '../public/js', name), 'utf8');
const moduleOf = name => import(`data:text/javascript;base64,${Buffer.from(read(name)).toString('base64')}`);

test('extended iPad anime buffering prefers hls.js with native fallback and leaves movies alone', async () => {
  const { deliverySources } = await moduleOf('capabilities.js');
  const apple = { hls: true, mse: true, nativeHlsPreferred: true };
  const movie = { kind: 'anime', hls: '/anime/m3u8/source/signature.m3u8' };
  assert.equal(deliverySources(movie, apple, 'key')[0].type, 'native-hls');
  const sources = deliverySources(movie, apple, 'key', 'ipad', { bufferMode: 'extended' });
  assert.deepEqual(sources.map(source => source.type), ['hls-js', 'native-hls']);
  assert.equal(sources[0].bufferMode, 'extended');
  assert.match(sources[0].url, /k=key&c=ipad/);
  assert.equal(deliverySources({ ...movie, kind: 'file' }, apple, 'key', null, { bufferMode: 'extended' })[0].type, 'native-hls');
  assert.equal(deliverySources(movie, { ...apple, mse: false }, 'key', null, { bufferMode: 'extended' })[0].type, 'native-hls');
});

test('extended buffering bounds memory while retaining dynamic resume loading and error fallback', async () => {
  const { FilePlayback } = await moduleOf('file-playback.js');
  let instance;
  class Hls {
    static isSupported() { return true; }
    static Events = { MEDIA_ATTACHED: 'attached', MANIFEST_PARSED: 'manifest', FRAG_BUFFERED: 'buffered', ERROR: 'error' };
    static ErrorTypes = { NETWORK_ERROR: 'network' };
    constructor(options) { this.options = options; this.events = {}; instance = this; }
    on(name, callback) { this.events[name] = callback; }
    attachMedia() { this.events.attached(); }
    loadSource() {}
    startLoad(position) { this.position = position; }
    destroy() {}
  }
  let failed = 0, position = 0;
  const video = { pause() {}, removeAttribute() {}, load() {} };
  const playback = new FilePlayback(video, { loader: async () => Hls, onFatal: () => failed++ });
  await playback.open({ type: 'hls-js', url: '/anime.m3u8', bufferMode: 'extended' }, () => position);
  assert.equal(instance.options.maxBufferLength, 90);
  assert.equal(instance.options.maxBufferSize, 64000000);
  assert.equal(instance.options.backBufferLength, 30);
  assert.equal(instance.options.preferManagedMediaSource, false);
  position = 815; instance.events.manifest();
  assert.equal(instance.position, 815);
  instance.events.error(null, { fatal: true, type: 'unsupported' });
  assert.equal(failed, 1);
});

function skips({ leader = false, control = true, auto = true, position = 50, episode = 2 } = {}) {
  const events = new Map(), timers = new Map(), actions = [];
  let timerId = 0;
  const classes = new Set();
  const label = {};
  const button = { hidden: true, offsetWidth: 100, style: { setProperty() {} }, appendChild() {},
    querySelector: () => label, addEventListener: (name, fn) => events.set(name, fn),
    classList: { add: name => classes.add(name), remove: name => classes.delete(name) } };
  const video = new EventTarget();
  const state = { movie: { id: 'ep2', kind: 'anime', anilistId: 114121, episode, episodes: 12,
    intro: { start: 40, end: 130 }, outro: { start: 1320, end: 1420 } }, state: { playing: true }, settings: { animeAutoSkip: auto } };
  const context = vm.createContext({
    S: state, video, document: { createElement: () => ({}) },
    $: selector => selector === '#animeSkip' ? button : selector === '#animeNext' ? { click: () => actions.push('next') } : null,
    store: { get: () => auto }, localPos: () => position, kindOf: movie => movie?.kind,
    canControl: () => control, animeAutomationLeader: () => leader, noPerm() {}, toast() {},
    sendCmd: (action, to) => actions.push([action, to]), selectAnime: message => actions.push(message),
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id), setInterval() {},
  });
  vm.runInContext(read('app.js').slice(read('app.js').indexOf('const AUTO_SKIP_DELAY')), context);
  return { state, button, label, actions, timers, video,
    update: () => context.updateAnimeSkip(), click: () => events.get('click')({ stopPropagation() {} }) };
}

test('guests with playback permission can skip an intro without racing automatic skips', () => {
  const f = skips();
  f.update();
  assert.equal(f.button.hidden, false);
  assert.equal(f.label.textContent, 'Skip Intro');
  assert.equal(f.actions.length, 0, 'only the elected viewer should issue automatic commands');
  f.click();
  assert.deepEqual(f.actions[0], ['seek', 130]);
  const denied = skips({ control: false });
  denied.update();
  assert.equal(denied.button.hidden, true);
});

test('outro countdowns are cancelled when the episode changes and final credits remain skippable', () => {
  const f = skips({ leader: true, position: 1350 });
  f.update();
  assert.equal(f.timers.size, 1);
  f.state.movie = { ...f.state.movie, id: 'ep3', outro: null };
  f.update();
  assert.equal(f.timers.size, 0);
  const last = skips({ episode: 12, position: 1350 });
  last.update(); last.click();
  assert.equal(last.label.textContent, 'Skip Credits');
  assert.deepEqual(last.actions[0], ['seek', 1420]);
});

test('the elected viewer advances at the end even without outro metadata, but other guests do not', () => {
  const f = skips({ leader: true });
  f.state.movie.outro = null;
  f.video.dispatchEvent(new Event('ended'));
  assert.deepEqual(f.actions, ['next']);
  const guest = skips(); guest.video.dispatchEvent(new Event('ended'));
  assert.equal(guest.actions.length, 0);
  const last = skips({ leader: true, episode: 12 }); last.video.dispatchEvent(new Event('ended'));
  assert.equal(last.actions.length, 0);
});

test('a shared toggle change cancels an armed outro before the countdown callback runs', () => {
  const f = skips({ leader: true, position: 1350 });
  f.update();
  const countdown = [...f.timers.values()][0];
  f.state.settings.animeAutoSkip = false;
  countdown();
  assert.equal(f.actions.length, 0, 'a remote disable must be checked again at countdown completion');
  const off = skips({ leader: true, auto: false });
  off.update();
  assert.equal(off.actions.length, 0);
  assert.equal(off.button.hidden, false, 'manual skipping remains available while automatic skipping is off');
});
