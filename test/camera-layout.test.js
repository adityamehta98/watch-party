'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const moduleOf = () => import(`data:text/javascript;base64,${Buffer.from(fs.readFileSync(path.join(__dirname, '../public/js/camera-layout.js'), 'utf8')).toString('base64')}`);

function clearLayout(layout, width, height) {
  for (const tile of layout) {
    assert.ok(tile.width > 0 && tile.height > 0);
    assert.ok(tile.x >= 0 && tile.y >= 0);
    assert.ok(tile.x + tile.width <= width + .01 && tile.y + tile.height <= height + .01);
  }
  for (let i = 0; i < layout.length; i++) for (let j = i + 1; j < layout.length; j++) {
    const a = layout[i], b = layout[j];
    assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y,
      `${a.id} must not overlap ${b.id}`);
  }
}

test('camera defaults remain equal and do not overlap across phone, tablet, and desktop layouts', async () => {
  const { cameraLayout } = await moduleOf();
  for (const [width, height] of [[390, 219], [320, 740], [844, 390], [1024, 768], [1440, 900]]) {
    for (const count of [2, 5, 12, 21]) {
      const layout = cameraLayout(width, height, Array.from({ length: count }, (_, i) => `viewer${i}`));
      clearLayout(layout, width, height);
      assert.equal(new Set(layout.map(tile => tile.width)).size, 1);
      assert.equal(new Set(layout.map(tile => tile.height)).size, 1);
    }
  }
});

test('old saved layouts cannot carry unequal sizes or stacked positions into new defaults', async () => {
  const { cameraLayout } = await moduleOf();
  const layout = cameraLayout(1024, 768, ['self', 'guest'], {
    self: { x: .8, y: .02, w: .2 }, guest: { x: .8, y: .02, w: .3 },
  });
  clearLayout(layout, 1024, 768);
  assert.equal(layout[0].width, layout[1].width);
});

test('a new participant triggers reflow if a manually saved tile occupies its default slot', async () => {
  const { cameraLayout } = await moduleOf();
  const layout = cameraLayout(1024, 768, ['new', 'saved'], {
    saved: { manual: true, x: (1024 - 12 - 184) / 1024, y: 64 / 768, w: 184 / 1024 },
  });
  clearLayout(layout, 1024, 768);
  assert.equal(layout[0].width, layout[1].width);
});

test('explicit manual placements survive when they remain clear of the other tiles', async () => {
  const { cameraLayout } = await moduleOf();
  const layout = cameraLayout(1024, 768, ['self', 'guest'], {
    self: { manual: true, x: .02, y: .5, w: .15 },
  });
  clearLayout(layout, 1024, 768);
  assert.equal(layout[0].x, 20.48);
  assert.equal(layout[0].width, 153.6);
  assert.deepEqual(cameraLayout(0, 0, ['self']), []);
});
