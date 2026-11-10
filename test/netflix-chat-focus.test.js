'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function fixture() {
  const listeners = new Map(), deferred = [], host = { isConnected: true };
  let open = true, foreground = true;
  const root = { activeElement: null, addEventListener(name, fn) { listeners.set(name, fn); }, getElementById: () => input };
  const input = { isConnected: true, focus() { root.activeElement = input; } };
  const target = { addEventListener(name, fn) { listeners.set(name, fn); } };
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/overlay-focus.js'), 'utf8'), context);
  const focus = context.WpOverlayFocus.create({ host, root, target, doc: { hasFocus: () => foreground },
    active: () => open, close: () => { open = false; }, defer: fn => deferred.push(fn) });
  return { focus, root, input,
    background() { foreground = false; },
    event(name, inside, extra = {}) {
      const event = { composedPath: () => inside ? [input, root, host] : [{}], stopImmediatePropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; }, ...extra };
      listeners.get(name)?.(event); return event;
    },
    flush() { for (const fn of deferred.splice(0)) fn(); },
  };
}
test('Netflix fading its controls cannot steal focus, including blur with a related player target', () => {
  const f = fixture(); f.focus.claim();
  for (let i = 0; i < 100; i++) {
    f.root.activeElement = null;
    f.event('focusout', true, { relatedTarget: { id: 'netflix-player' } });
    f.event('focusin', false); f.flush();
    assert.equal(f.root.activeElement, f.input);
  }
  const space = f.event('keydown', true, { key: ' ' });
  assert.equal(space.stopped, true);
  assert.equal(space.prevented, undefined, 'normal typing keeps its browser default');
});
test('outside click and closing chat release the keyboard; moving the mouse does not', () => {
  const f = fixture(); f.focus.claim();
  f.event('pointermove', false);
  assert.equal(f.focus.owned, true);
  f.event('pointerdown', false); f.root.activeElement = null; f.event('focusin', false); f.flush();
  assert.equal(f.focus.owned, false);
  assert.equal(f.root.activeElement, null);
  f.focus.claim();
  const escape = f.event('keydown', true, { key: 'Escape' });
  assert.equal(escape.prevented, true);
  assert.equal(f.focus.owned, false);
});
test('switching apps never pulls focus back to Netflix chat', () => {
  const f = fixture(); f.focus.claim(); f.background(); f.root.activeElement = null;
  f.event('focusout', true); f.flush();
  assert.equal(f.root.activeElement, null);
});
