'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function fixture(kind = 'anime') {
  const handlers = {}, row = {}, classes = new Set(), requested = [];
  const pop = { hidden: false, querySelector: () => row, addEventListener: (type, fn) => { handlers[type] = fn; } };
  const hls = { levels: [{ height: 720 }, { height: 1080 }], autoLevelEnabled: true, loadLevel: -1 };
  const context = vm.createContext({ S: { movie: { kind } }, filePlayback: { hls, source: { type: 'hls-js' } },
    video: { videoHeight: 720, currentTime: 80 }, kindOf: m => m.kind, isNativeMovie: m => m.kind === 'anime',
    $: id => id === '#playerMorePop' ? pop : { addEventListener: (_, fn) => { handlers.done = fn; } },
    setHtml: (el, html) => { el.html = html; }, esc: String, moreMenu: { update() {} },
    visualPrefs: {}, visuals: { reasons: [] }, isTheater: false, window: {},
    remote: { linked: true, post: m => requested.push(m) }, ytMedia: { setNativeControls(show) { this.nativeControls = show; } },
    stage: { classList: { add: c => classes.add(c), remove: c => classes.delete(c) } } });
  const source = read('public/js/ui/sources.js');
  vm.runInContext(source.slice(source.indexOf('function renderMoreControls()'), source.indexOf('function renderVisualControls()')), context);
  context.renderMoreControls();
  return { context, handlers, hls, row, pop, classes, requested };
}

test('HLS quality choices use actual levels, switch locally, and reject invalid indices', () => {
  const f = fixture(); assert.match(f.row.html, /Auto/); assert.match(f.row.html, /720p/); assert.match(f.row.html, /1080p/);
  f.handlers.change({ target: { matches: () => true, value: '1' } }); assert.equal(f.hls.nextLevel, 1);
  assert.equal(f.context.video.currentTime, 80);
  f.handlers.change({ target: { matches: () => true, value: '99' } }); assert.equal(f.hls.nextLevel, 1);
  f.handlers.change({ target: { matches: () => true, value: '-1' } }); assert.equal(f.hls.nextLevel, -1);
});

test('quality lists every advertised resolution without minimum or maximum caps', () => {
  const f = fixture(), heights = [144, 240, 360, 480, 720, 1080, 1440, 2160, 3840, 4320];
  f.hls.levels = heights.map(height => ({ height })); f.context.renderMoreControls();
  for (const height of heights) assert.ok(f.row.html.includes(`>${height}p</option>`));
  assert.equal((f.row.html.match(/<option /g) || []).length, heights.length + 1);
});

test('YouTube quality exposes native controls and Done restores the custom player', () => {
  const f = fixture('youtube'); assert.match(f.row.html, /Player settings/);
  f.handlers.click({ target: { closest: () => ({}) } });
  assert.ok(f.classes.has('youtube-settings')); assert.equal(f.context.ytMedia.nativeControls, true); assert.equal(f.pop.hidden, true);
  f.handlers.done(); assert.equal(f.classes.size, 0); assert.equal(f.context.ytMedia.nativeControls, false);
});

test('subscription-service quality is routed to its real player through the extension', () => {
  const f = fixture('service');
  f.handlers.click({ target: { closest: () => ({}) } }); assert.equal(f.requested[0].type, 'quality-settings');
  const source = read('extension/service.js');
  let clicks = 0, failure = 0;
  const button = { getClientRects: () => [1], click: () => clicks++ };
  const doc = { querySelectorAll: () => [button] };
  const context = vm.createContext({ document: doc, pick: () => ({ getRootNode: () => doc }), send: () => failure++ });
  vm.runInContext(source.slice(source.indexOf('function apply(c)'), source.indexOf('chrome.runtime.onMessage.addListener', source.indexOf('function apply(c)'))), context);
  context.apply({ op: 'quality' }); assert.equal(clicks, 1);
  doc.querySelectorAll = () => []; context.apply({ op: 'quality' }); assert.equal(failure, 1);
});

test('buffering, room catch-up and shared waits show only a spinner; blocked playback stays actionable', () => {
  const source = read('public/js/ui/controls.js'), el = {};
  const context = vm.createContext({ $: () => el, S: { movie: { id: 'm' }, state: {} }, M: {}, remote: {},
    video: { readyState: 4 }, player: {}, codecWarning: '', tuneIn: {}, esc: String, hideTuneIn() {} });
  vm.runInContext(source.slice(source.indexOf('function renderNotice()'), source.indexOf("for (const event of ['loadeddata'")), context);
  for (const mode of ['syncing', 'buffering', 'waiting']) {
    context.player.syncing = mode === 'syncing'; context.S._buffering = mode === 'buffering'; context.S.state.waiting = mode === 'waiting';
    context.renderNotice(); assert.match(el.innerHTML, /class="spinner"/); assert.doesNotMatch(el.innerHTML, /<span>|Buffering|Catching/);
  }
  context.player.blocked = true; context.renderNotice(); assert.match(el.innerHTML, /Click anywhere/);
});
