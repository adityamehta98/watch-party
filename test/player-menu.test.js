'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = require('./app-source');
const menuModule = () => import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path.join(__dirname, '../public/js/player-menu.js'), 'utf8')).toString('base64'));

test('menu camera and microphone states describe current sharing, with matching on/off icons', async () => {
  const { playerMenuState } = await menuModule();
  const off = playerMenuState({});
  assert.equal(off.camBtn.on, false); assert.equal(off.camBtn.icon, 'cam-off');
  assert.equal(off.micBtn.on, false); assert.equal(off.micBtn.icon, 'mic-off');
  const on = playerMenuState({ cam: true, mic: true });
  assert.equal(on.camBtn.on, true); assert.equal(on.camBtn.icon, 'cam');
  assert.equal(on.micBtn.on, true); assert.equal(on.micBtn.icon, 'mic');
});

test('menu explains automatically paused lighting and automatic battery saver', async () => {
  const { playerMenuState } = await menuModule();
  let state = playerMenuState({ ambientPreference: true, ambientAllowed: false,
    ambientReason: 'battery saver', saver: true, saverReason: 'low battery' });
  assert.equal(state.ambientBtn.on, false);
  assert.equal(state.ambientBtn.status, 'Paused');
  assert.equal(state.ambientBtn.detail, 'Paused: battery saver');
  assert.equal(state.ecoBtn.on, true);
  assert.equal(state.ecoBtn.detail, 'Automatic: low battery');
  state = playerMenuState({ ambientPreference: false, ambientAllowed: true, saver: true, manualSaver: true });
  assert.equal(state.ambientBtn.status, undefined, 'a user-disabled effect is Off rather than Paused');
  assert.equal(state.ecoBtn.detail, 'Use less power');
  assert.equal(playerMenuState({ ambientPreference: true, ambientAllowed: true }).ambientBtn.on, true);
});

function idleFixture({ playing = true, hover = false, pointerHover = true, focus = false } = {}) {
  const timers = new Map(), intervals = [];
  let sequence = 0;
  const classes = new Set();
  const controls = { classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) } };
  const actions = {}, social = {}, pops = Object.fromEntries(['#reactPop', '#animeReactPop', '#ccPop', '#playerMorePop', '#quickChat', '#notificationPanel'].map(id => [id, { hidden: true }]));
  const stage = { dataset: { idle: 'false' },
    querySelectorAll: () => [actions, social],
    querySelector: selector => selector.includes(':focus-visible') ? focus : hover };
  const S = { state: { playing } };
  const context = vm.createContext({ stage, S, dragFrac: null,
    $: id => id === '#controls' ? controls : pops[id],
    matchMedia: () => ({ matches: pointerHover }),
    clearTimeout: id => timers.delete(id),
    setTimeout: (callback, delay) => { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
    setInterval: callback => intervals.push(callback) });
  vm.runInContext(app.slice(app.indexOf('let idleTimer = null'), app.indexOf('let lastMove = 0')), context);
  const tick = delay => {
    const item = [...timers].find(([, value]) => value.delay === delay);
    assert.ok(item, 'expected timer at ' + delay);
    timers.delete(item[0]); item[1].callback();
  };
  return { stage, S, controls, actions, social, pops, tick, intervals, poke: () => context.poke() };
}

test('episode, language, social and playback controls become inert together and wake together', () => {
  const f = idleFixture();
  f.poke(); f.tick(2800);
  assert.equal(f.stage.dataset.idle, 'true');
  for (const element of [f.controls, f.actions, f.social]) assert.equal(element.inert, true);
  f.tick(300); assert.equal(f.controls.classList.contains('gone'), true);
  f.poke();
  assert.equal(f.stage.dataset.idle, 'false');
  for (const element of [f.controls, f.actions, f.social]) assert.equal(element.inert, false);
  assert.equal(f.controls.classList.contains('gone'), false);
});

test('open settings, keyboard interaction and desktop toolbar hover prevent idle hiding', () => {
  for (const options of [{ hover: true }, { focus: true }, {}]) {
    const f = idleFixture(options);
    if (!options.hover && !options.focus) f.pops['#playerMorePop'].hidden = false;
    f.poke(); f.tick(2800);
    assert.equal(f.stage.dataset.idle, 'false');
  }
});

test('touch hover does not stick controls open; paused playback restores hidden controls', () => {
  const f = idleFixture({ hover: true, pointerHover: false });
  f.poke(); f.tick(2800);
  assert.equal(f.stage.dataset.idle, 'true');
  f.S.state.playing = false; f.intervals[0]();
  assert.equal(f.stage.dataset.idle, 'false');
  f.tick(2800); assert.equal(f.stage.dataset.idle, 'false');
});

test('menu toggles remain open through forwarded button clicks; actions close and disabled items do nothing', () => {
  const listeners = {}, pop = { hidden: false, addEventListener: (event, fn) => { listeners.menu = fn; } };
  let clicks = 0, updates = 0, pokes = 0;
  const document = {
    getElementById: () => ({ click() { clicks++; listeners.document({ target: { closest: () => null } }); } }),
    addEventListener: (event, fn) => { listeners.document = fn; },
  };
  const context = vm.createContext({ document, $: () => pop, closePops: () => { pop.hidden = true; },
    renderMoreControls: () => updates++, poke: () => pokes++ });
  vm.runInContext(app.slice(app.indexOf('let forwardingMoreControl = false'), app.indexOf('function subtitleTimingKey(')), context);
  const click = action => listeners.menu({ target: { closest: () => action }, stopPropagation() {} });
  click({ dataset: { control: 'camBtn', toggle: 'true' } });
  assert.equal(clicks, 1); assert.equal(pop.hidden, false); assert.equal(updates, 1);
  click({ dataset: { control: 'ecoBtn', toggle: 'true' } });
  assert.equal(clicks, 2); assert.equal(pop.hidden, false); assert.equal(pokes, 2);
  click({ disabled: true, dataset: { control: 'pipBtn' } }); assert.equal(clicks, 2);
  click({ dataset: { control: 'backBtn' } }); assert.equal(clicks, 3); assert.equal(pop.hidden, true);
  pop.hidden = false; listeners.document({ target: { closest: () => null } }); assert.equal(pop.hidden, true);
});
