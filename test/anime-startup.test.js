'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8');

function startup() {
  let now = 0, id = 0;
  const timers = new Map();
  const setTimeout = (fn, delay = 0) => { timers.set(++id, { fn, at: now + delay }); return id; };
  const clearTimeout = id => timers.delete(id);
  const classList = () => {
    const classes = new Set();
    return { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) };
  };
  const overlay = { hidden: true, classList: classList() }, title = {};
  const steps = Array.from({ length: 4 }, () => ({ classList: classList() }));
  const elements = { '#tuneIn': overlay, '#tuneInTitle': title, '#tuneInSteps': { querySelectorAll: () => steps } };
  const context = vm.createContext({
    $: selector => elements[selector], performance: { now: () => now },
    video: new EventTarget(), setTimeout, clearTimeout,
    setInterval: () => ++id, clearInterval() {},
  });
  const app = require('./app-source');
  vm.runInContext(app.slice(app.indexOf('const tuneIn ='), app.indexOf("let episodePickerKey = ''")), context);
  return { context, overlay, title,
    show(label = 'Episode 1') { context.showTuneIn(label); },
    hide(force = false) { context.hideTuneIn(force); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn();
      }
      now = end;
    },
  };
}

test('anime loading screen exits while foreground progress reports arrive every 100 ms', () => {
  const f = startup();
  f.show();
  // Embedded playback reports keep arriving faster than the exit animation.
  for (let i = 0; i < 35; i++) { f.hide(); f.advance(100); }
  assert.equal(f.overlay.hidden, true, 'progress reports must not postpone the exit until the tab is hidden');
});

test('a new episode cancels the previous loading screen exit', () => {
  const f = startup();
  f.show(); f.advance(2300); f.hide();
  f.advance(100); f.show('Episode 2'); f.advance(500);
  assert.equal(f.overlay.hidden, false);
  assert.equal(f.title.textContent, 'Episode 2');
  f.hide(); f.advance(2500);
  assert.equal(f.overlay.hidden, true);
});

test('a new episode also cancels a pending minimum loading time', () => {
  const f = startup();
  f.show(); f.hide(); f.advance(100); f.show('Episode 2'); f.hide();
  f.advance(650);
  assert.equal(f.overlay.hidden, false, 'the new episode keeps its own minimum display time');
  f.advance(400);
  assert.equal(f.overlay.hidden, true);
});

function animeSelection(f, movie = null) {
  const messages = [];
  f.context.S = { movie };
  f.context.saveAnimeProgress = () => {};
  f.context.conn = { send: message => messages.push(message) };
  const app = require('./app-source');
  vm.runInContext(app.slice(app.indexOf('function selectAnime(message)'), app.indexOf('// Save promptly on pause/exit')), f.context);
  return { messages, select: message => f.context.selectAnime(message) };
}

test('new episode animation survives outgoing playback until the selected movie arrives', () => {
  const f = startup(), selection = animeSelection(f);
  selection.select({ anilistId: 114121, ep: 2, lang: 'dub', title: 'Immortal King' });
  assert.equal(f.overlay.hidden, false);
  assert.equal(f.title.textContent, 'Immortal King · Ep 2 (Dub)');
  assert.equal(selection.messages[0].type, 'select-anime');
  for (let i = 0; i < 35; i++) { f.hide(); f.advance(100); }
  assert.equal(f.overlay.hidden, false, 'outgoing video readiness must not reveal an unresolved episode');
  f.context.showTuneInForMovie({ title: 'Immortal King · Ep 2 (Dub)' });
  f.hide(); f.advance(250);
  assert.equal(f.overlay.hidden, false, 'the accepted episode keeps a short transition before fading');
  f.advance(600);
  assert.equal(f.overlay.hidden, true);
});

test('resuming the current episode animates even without another movie message', () => {
  const f = startup(), selection = animeSelection(f, { kind: 'anime', anilistId: 114121, episode: 1, language: 'dub' });
  selection.select({ anilistId: 114121, ep: 1, lang: 'dub', title: 'Immortal King', resume: true });
  assert.equal(f.overlay.hidden, false);
  for (let i = 0; i < 29; i++) { f.hide(); f.advance(100); }
  assert.equal(f.overlay.hidden, true, 'same-episode resume must fade without waiting for a new source');
});

test('joining or refreshing an already selected anime also shows the startup animation', () => {
  const f = startup();
  f.context.showTuneInForMovie({ title: 'Immortal King · Ep 1 (Dub)' });
  f.hide(); f.advance(600);
  assert.equal(f.overlay.hidden, false);
  f.advance(700);
  assert.equal(f.overlay.hidden, true);
});

test('ready paused embeds expose their controls and embed errors clear the loading screen', () => {
  const f = startup();
  f.context.scheduleUi = () => {};
  const callback = /onChange: (\(\) => \{ scheduleUi\(\);[^\n]+\}),/.exec(require('./app-source'))[1];
  vm.runInContext(`globalThis.playbackChanged = ${callback}`, f.context);
  f.show();
  f.context.M = { isAdapter: true, readyState: 0, paused: true };
  f.context.playbackChanged(); f.advance(3000);
  assert.equal(f.overlay.hidden, false, 'an unloaded embed still needs the loading screen');
  f.context.M.readyState = 4;
  f.context.playbackChanged(); f.advance(600);
  assert.equal(f.overlay.hidden, true, 'ready native controls must be accessible when autoplay needs a click');
  f.show('Episode 2'); f.context.M.error = { code: 3 };
  f.context.playbackChanged();
  assert.equal(f.overlay.hidden, true, 'errors must not be covered by the loading screen');
});

test('a playback error can dismiss the loading screen immediately during its exit', () => {
  const f = startup();
  f.show(); f.advance(2300); f.hide(); f.hide(true);
  assert.equal(f.overlay.hidden, true);
  f.show('Episode 2'); f.advance(500);
  assert.equal(f.overlay.hidden, false);
});

test('native anime clears the loading screen while video progress continues in the foreground', () => {
  const f = startup();
  f.context.scheduleUi = () => {};
  f.context.M = { readyState: 4, paused: false };
  const callback = /onChange: (\(\) => \{ scheduleUi\(\);[^\n]+\}),/.exec(require('./app-source'))[1];
  vm.runInContext(`globalThis.playbackChanged = ${callback}`, f.context);
  f.show();
  for (let i = 0; i < 35; i++) { f.context.playbackChanged(); f.advance(100); }
  assert.equal(f.overlay.hidden, true);
});

test('source errors release the loading screen so the episode can be retried', () => {
  const f = startup();
  let receive;
  f.context.conn = { on(type, callback) { if (type === 'toast') receive = callback; } };
  f.context.toast = () => {};
  const app = require('./app-source');
  vm.runInContext(app.slice(app.indexOf("  conn.on('toast',"), app.indexOf("  conn.on('error',")), f.context);
  f.show(); receive({ type: 'toast', kind: 'error', selection: 'anime', text: 'Try again' });
  assert.equal(f.overlay.hidden, true);
});

test('retrying an old embedded episode resolves it into Watch Party native playback', async t => {
  const { Room } = require('../server/room');
  let resolutions = 0;
  const room = new Room({ config: { adminKey: 'admin-secret-key', roomKey: 'guestsecretkey1234' }, library: {},
    animeResolve: async () => { resolutions++; return { url: 'https://cdn.example/master.m3u8', referer: 'https://megavid.buzz/' }; } });
  t.after(() => room.shutdown());
  const host = { role: 'host', name: 'Host', admitted: true, ws: { readyState: 0 } };
  const selection = { anilistId: 114121, malId: 41094, ep: 1, lang: 'dub' };
  await room.selectAnime(host, selection);
  room.movie = { ...room.movie, kind: 'megaplay', url: 'https://megaplay.buzz/stream/ani/114121/1/dub' };
  await room.selectAnime(host, selection);
  assert.equal(resolutions, 2, 'an embedded episode must not take the native same-episode shortcut');
  assert.equal(room.movie.kind, 'anime');
  assert.match(room.publicMovie().hls, /^\/anime\/m3u8\//);
  assert.equal(room.publicMovie().url, null);
});

test('source responses without a video cannot turn the provider homepage into an HLS source', () => {
  const { parseSource } = require('../server/anime');
  for (const response of [{}, { success: false }, { tracks: [] }, { source: '  ' }, { sources: [] }]) {
    assert.equal(parseSource(response, 'megavid.buzz'), null);
  }
});
