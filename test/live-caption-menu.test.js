'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
function fixture() {
  const handlers = new Map(), queued = [], notices = []; let click, off = 0;
  const children = [], track = { mode: 'hidden', cues: [] };
  const doc = { head: { append() {} }, body: { append() {} }, getElementById: id => id === 'ccPop' ? pop : id === 'ccBtn' ? button : null,
    createElement: () => ({ ownerDocument: doc, dataset: {}, setAttribute() {}, querySelector: () => ({ addEventListener() {} }), remove() { const i = children.indexOf(this); if (i >= 0) children.splice(i, 1); } }) };
  const button = { classList: { add() {}, toggle() {} } };
  const pop = { ownerDocument: doc, hidden: false, append: el => children.push(el), addEventListener: (_, fn) => { click = fn; },
    querySelectorAll: selector => children.filter(el => Object.keys(el.dataset).some(k => 'data-' + k.replace(/[A-Z]/g, c => '-' + c.toLowerCase()) === selector.slice(1, -1).toLowerCase())) };
  const context = vm.createContext({ queueMicrotask: fn => queued.push(fn), window: { wpSelectSub: () => off++ }, localStorage: { getItem: () => null, setItem() {} }, MutationObserver: class { constructor(fn) { this.fn = fn; } observe() {} disconnect() {} } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/live-captions.js'), 'utf8').replace('export function', 'function') + '\nglobalThis.init = initLiveCaptions;', context);
  const live = context.init({ conn: { on: (type, fn) => handlers.set(type, fn), send() {} }, video: { addTextTrack: () => track }, key: 'fake', isHost: true, doc, notify: message => notices.push(message) });
  const drain = () => { let n = 0; while (queued.length && n++ < 100) queued.shift()(); assert.ok(n < 100); };
  const emit = (type, m) => { handlers.get(type)(m); drain(); };
  emit('settings', { settings: { aiFeatures: true } });
  return { emit, children, track, notices, live, off: () => off, clickSub() { click({ target: { closest: selector => selector === '[data-sub]' ? {} : null } }); drain(); } };
}
test('caption, recap and highlight updates always leave exactly one compact section with tooltips', () => {
  const f = fixture();
  for (let i = 0; i < 30; i++) { f.emit('captions-status', { ok: true, active: true }); f.emit('recap', { reason: 'busy' }); f.emit('highlights', { status: 'working' }); }
  assert.equal(f.children.length, 1);
  const html = f.children[0].innerHTML;
  assert.equal((html.match(/data-live="recap"/g) || []).length, 1);
  assert.match(html, /title="Summarizes/); assert.doesNotMatch(html, /menu-note|menu-label/);
  f.emit('settings', { settings: { aiFeatures: false } }); assert.equal(f.children.length, 0);
  f.emit('settings', { settings: { aiFeatures: true } }); assert.equal(f.children.length, 1);
});
test('errors go once to notifications instead of expanding the menu', () => {
  const f = fixture(); for (let i = 0; i < 20; i++) f.emit('captions-status', { ok: true, active: true, reason: 'error' });
  assert.equal(f.notices.length, 1); assert.equal(f.children.length, 1); assert.doesNotMatch(f.children[0].innerHTML, /Retrying/);
});
test('automatic live-caption activation clears regular subtitles and normal CC Off hides live captions', () => {
  const f = fixture(); f.emit('captions-status', { ok: true, active: true });
  assert.equal(f.track.mode, 'showing'); assert.ok(f.off() > 0);
  f.clickSub(); assert.equal(f.track.mode, 'hidden');
});
