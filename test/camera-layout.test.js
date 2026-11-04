'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = name => fs.readFileSync(path.join(__dirname, '../public/js/' + name), 'utf8');
const urlOf = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64');
const moduleOf = () => import(urlOf(source('camera-layout.js')));

test('camera strip is horizontal, equally sized, bounded and anchored at the top right', async () => {
  const { cameraPage, cameraLayout } = await moduleOf();
  for (const [width, height] of [[390, 219], [320, 740], [844, 390], [1024, 768], [1440, 900], [100, 80]]) {
    for (const count of [1, 2, 4, 5, 12, 21]) {
      const view = cameraPage(Array.from({ length: count }, (_, i) => 'viewer' + i));
      const layout = cameraLayout(width, height, view.entries, view.slots);
      assert.ok(layout.length <= 4);
      assert.equal(new Set(layout.map(tile => tile.y)).size, 1);
      assert.equal(new Set(layout.map(tile => tile.width)).size, 1);
      assert.equal(new Set(layout.map(tile => tile.height)).size, 1);
      assert.ok(Math.abs(layout[0].x + layout[0].width - (width - Math.min(12, width / 12, height / 12))) < .01);
      for (const tile of layout) {
        assert.ok(tile.width > 0 && tile.height > 0 && tile.x >= 0 && tile.y >= 0);
        assert.ok(tile.x + tile.width <= width + .01 && tile.y + tile.height <= height + .01);
      }
      for (let i = 1; i < layout.length; i++) assert.ok(layout[i].x + layout[i].width <= layout[i - 1].x);
    }
  }
  assert.deepEqual(cameraLayout(0, 0, []), []);
});

test('paging visits every camera exactly once when no cameras are pinned', async () => {
  const { cameraPage } = await moduleOf();
  for (const count of [0, 1, 4, 5, 8, 9, 21]) {
    const ids = Array.from({ length: count }, (_, i) => 'v' + i);
    const seen = [];
    for (let page = 0; page < cameraPage(ids).pages; page++) {
      seen.push(...cameraPage(ids, [], page).entries.map(entry => entry.id));
    }
    assert.deepEqual(seen, ids);
  }
});

test('pins retain exact slots and coordinates through every page, including the final page', async () => {
  const { cameraPage, cameraLayout } = await moduleOf();
  const ids = Array.from({ length: 11 }, (_, i) => 'v' + i), pins = ['v0', null, 'v6'];
  const seen = new Set();
  let fixed;
  for (let page = 0; page < cameraPage(ids, pins).pages; page++) {
    const view = cameraPage(ids, pins, page);
    assert.ok(view.entries.length <= 4);
    const layout = cameraLayout(1024, 768, view.entries, view.slots);
    const pinned = layout.filter(tile => tile.pinned);
    if (fixed) assert.deepEqual(pinned, fixed);
    fixed = pinned;
    view.entries.forEach(entry => seen.add(entry.id));
    assert.equal(new Set(view.entries.map(entry => entry.id)).size, view.entries.length);
  }
  assert.deepEqual([...seen].sort(), ids.sort());
});

test('departures remove stale pins and clamp pages; all pinned slots can be unlocked', async () => {
  const { cameraPage } = await moduleOf();
  const pins = ['a', 'b', 'c', 'd'];
  const locked = cameraPage(['a', 'b', 'c', 'd', 'e'], pins, 10);
  assert.equal(locked.locked, true);
  assert.equal(locked.pages, 1);
  assert.equal(locked.page, 0);
  const unpinned = cameraPage(['a', 'b', 'c', 'd', 'e'], ['a', 'b', 'c'], 1);
  assert.ok(unpinned.entries.some(entry => entry.id === 'e'));
  const left = cameraPage(['b', 'd'], pins, 100);
  assert.equal(left.page, 0);
  assert.deepEqual(left.entries.map(entry => entry.id).sort(), ['b', 'd']);
  assert.equal(left.pins.includes('a'), false);
  assert.deepEqual(cameraPage([], pins).entries, []);
  assert.equal(cameraPage(['a', 'a', 'b'], ['a', 'a']).entries.length, 2);
});

// Exercise the production gallery event handlers without camera permissions.
class Element {
  constructor(tag, doc) {
    this.tag = tag; this.ownerDocument = doc; this.children = []; this.attrs = {};
    this.listeners = {}; this.style = { setProperty(key, value) { this[key] = value; } };
    this.classList = { toggle: (name, on) => {
      const names = new Set((this.className || '').split(' '));
      on ? names.add(name) : names.delete(name); this.className = [...names].join(' ');
    } };
  }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attrs[name] = value; }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  querySelector(selector) { return this.children.find(el => (el.className || '').split(' ').includes(selector.slice(1))) || null; }
  click() { if (!this.disabled) this.listeners.click?.({ stopPropagation() {} }); }
}

test('gallery arrows and pin buttons preserve video elements and handle joins, departures and renames', async () => {
  const layoutUrl = urlOf(source('camera-layout.js'));
  const { createCameraGallery } = await import(urlOf(source('camera-gallery.js').replace("'./camera-layout.js'", JSON.stringify(layoutUrl))));
  const doc = { createElement: tag => new Element(tag, doc) };
  const box = new Element('div', doc), gallery = createCameraGallery(box), tiles = new Map();
  for (let i = 0; i < 9; i++) {
    const el = new Element('div', doc), video = new Element('video', doc);
    el.append(video); box.append(el); tiles.set('v' + i, { el, video, name: 'Person ' + i });
  }
  gallery.sync(tiles); gallery.layout(1024, 768);
  const nav = box.querySelector('.camera-pages'), [previous, status, next] = nav.children;
  assert.equal(nav.hidden, false); assert.equal(previous.disabled, true);
  const pinned = tiles.get('v1'), video = pinned.video;
  pinned.el.querySelector('.camera-pin').click();
  const initialLeft = pinned.el.style.left;
  assert.equal(pinned.el.querySelector('.camera-pin').attrs['aria-pressed'], 'true');
  next.click();
  assert.equal(pinned.el.hidden, false);
  assert.equal(pinned.el.style.left, initialLeft);
  assert.equal(pinned.el.children[0], video);
  assert.equal(status.textContent, '2 / 3');
  gallery.layout(390, 219);
  assert.equal(pinned.el.hidden, false);
  pinned.name = 'Renamed'; gallery.sync(tiles);
  assert.equal(pinned.el.querySelector('.camera-pin').attrs['aria-label'], 'Unpin Renamed camera');
  previous.click(); assert.equal(status.textContent, '1 / 3');
  for (const [id] of tiles) if (!['v1', 'v8'].includes(id)) tiles.delete(id);
  gallery.sync(tiles); assert.equal(nav.hidden, true);
  assert.equal(pinned.el.hidden, false);
  gallery.sync(new Map()); assert.equal(box.className.includes('has-cameras'), false);
  assert.equal(nav.hidden, true);
});
