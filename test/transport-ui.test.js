'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '../public/js/ui', file), 'utf8');

test('pausing after rapid skips sends the latest seek before pause, preserving its destination', () => {
  const sent = [], timers = new Map(); let id = 0;
  const source = read('controls.js');
  const context = vm.createContext({ S: { movie: { id: 'm' }, state: { playing: true } }, clientId: 'host',
    canControl: () => true, player: { setState() {} }, renderNotice() {}, scheduleUi() {},
    conn: { clock: { now: () => 10000 }, send: m => sent.push(m) }, performance: { now: () => 1000 },
    setTimeout: fn => { timers.set(++id, fn); return id; }, clearTimeout: id => timers.delete(id) });
  vm.runInContext(source.slice(source.indexOf('function predict(patch)'), source.indexOf('function togglePlay()')), context);
  context.sendCmd('seek', 110); context.sendCmd('seek', 120);
  assert.equal(sent.length, 1); assert.equal(timers.size, 1);
  context.sendCmd('pause', 120);
  assert.deepEqual(sent.map(m => [m.action, m.position]), [['seek', 110], ['seek', 120], ['pause', 120]]);
  assert.equal(timers.size, 0);
});

test('play/pause uses an in-flight adapter seek destination instead of its stale API clock', () => {
  const source = read('core.js');
  const context = vm.createContext({ M: { isAdapter: true, seekingTarget: 120, currentTime: 100, readyState: 4 }, player: { expected: () => 90 } });
  vm.runInContext(source.slice(source.indexOf('function localPos()'), source.indexOf('async function api(')), context);
  assert.equal(context.localPos(), 120);
  context.M.seekingTarget = null; assert.equal(context.localPos(), 100);
});
