'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { Room } = require('../server/room');
const source = require('./app-source');
function client(id, role = 'guest', session = id) {
  const messages = [];
  return { id, role, session, admitted: true, perms: {}, messages, ws: { readyState: 1, send: raw => messages.push(JSON.parse(raw)) } };
}
function room(t) { const r = new Room({ config: { adminKey: 'host-secret', roomKey: 'guestsecretkey1234', room: {} }, library: {} }); t.after(() => r.shutdown()); return r; }
test('notification history is private to the signed session and never broadcast', t => {
  const r = room(t), host = client('host01', 'host'), a = client('guest1', 'guest', 'private-a'), b = client('guest2', 'guest', 'private-b');
  for (const c of [host, a, b]) r.clients.set(c.id, c);
  r.onMessage(a, { type: 'notification', id: 'notice1', text: 'Ambient light on', ts: 0, owner: 'private-b' });
  assert.equal(a.messages.length, 1); assert.equal(b.messages.length, 0); assert.equal(host.messages.length, 0);
  assert.equal(r.notificationHistory(a).length, 1); assert.equal(r.notificationHistory(b).length, 0);
  assert.ok(r.notificationHistory(a)[0].ts > 0); assert.equal(r.notificationHistory(a)[0].owner, undefined);
  assert.equal(r.notificationHistory(client('other-id', 'guest', 'private-a')).length, 1, 'same browser session survives reconnect');
  assert.equal(r.notificationHistory(client('guest1', 'guest', 'private-b')).length, 0, 'public IDs cannot read another history');
});
test('only the host clears all histories; a new process starts empty', t => {
  const r = room(t), host = client('host01', 'host'), guest = client('guest1');
  r.clients.set(host.id, host); r.clients.set(guest.id, guest);
  for (const c of [host, guest]) r.onMessage(c, { type: 'notification', id: 'notice1', text: c.role });
  r.onMessage(guest, { type: 'notifications-clear' }); assert.equal(r.notifications.length, 2);
  r.onMessage(host, { type: 'notifications-clear' }); assert.equal(r.notifications.length, 0);
  assert.equal(guest.messages.at(-1).type, 'notifications-clear');
  const fresh = room(t); assert.equal(fresh.notifications.length, 0); assert.notEqual(fresh.notificationSession, r.notificationSession);
});
test('notification storage is bounded, deduplicated and requires admission', t => {
  const r = room(t), guest = client('guest1');
  r.onMessage({ ...guest, admitted: false }, { type: 'notification', id: 'notice1', text: 'blocked' });
  assert.equal(r.notifications.length, 0);
  for (let i = 0; i < 1100; i++) r.onMessage(guest, { type: 'notification', id: 'notice' + i, text: 'x'.repeat(900), kind: 'untrusted-kind' });
  assert.equal(r.notifications.length, 1000); assert.equal(r.notifications[0].text.length, 500); assert.equal(r.notifications[0].kind, 'info');
  r.onMessage(guest, { type: 'notification', id: 'notice1099', text: 'duplicate' }); assert.equal(r.notifications.length, 1000);
});
class Element {
  constructor() { this.children = []; this.dataset = {}; this.listeners = {}; this.hidden = false; }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
}
async function center(host = false) {
  const { createNotificationCenter } = await import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(path.join(__dirname, '../public/js/notifications.js'))).toString('base64'));
  const panel = new Element(), list = new Element(), clear = new Element(), sent = []; let seq = 0;
  panel.ownerDocument = { createElement: () => new Element() };
  panel.querySelector = selector => selector.includes('list') ? list : clear;
  const feed = createNotificationCenter(panel, { send: m => sent.push(m), host, id: () => 'notice' + (++seq) });
  return { panel, list, clear, sent, feed };
}
test('notification center has timestamps, safe text, host-only clear and reusable important actions', async () => {
  const guest = await center(); assert.equal(guest.clear.hidden, true); guest.clear.listeners.click(); assert.equal(guest.sent.length, 0);
  const host = await center(true); assert.equal(host.clear.hidden, false);
  let acted = false;
  host.feed.record('<img onerror=bad()>', 'request', [{ label: 'Allow', run: () => { acted = true; } }]);
  assert.equal(host.list.children[0].children[1].textContent, '<img onerror=bad()>');
  assert.ok(host.list.children[0].children[0].dateTime.endsWith('Z'));
  host.panel.hidden = true; host.panel.hidden = false; host.feed.render(); assert.equal(host.list.children.length, 1, 'closing the panel does not erase history');
  host.list.children[0].children[2].listeners.click(); assert.equal(acted, true);
  host.clear.listeners.click(); assert.equal(host.sent.at(-1).type, 'notifications-clear');
  host.feed.clear(); assert.equal(host.list.children[0].textContent, 'No notifications this session.');
});
test('offline notices are resent on reconnect and discarded after host-process restart', async () => {
  const f = await center(); f.feed.load([], 'session-a'); f.feed.record('Offline notice', 'info', []);
  f.feed.load([], 'session-a'); assert.equal(f.sent.length, 2);
  f.feed.add({ id: 'notice1', ts: Date.now(), text: 'Offline notice', kind: 'info' });
  f.feed.load([], 'session-b'); assert.equal(f.list.children[0].textContent, 'No notifications this session.');
});
test('rapid clicks leave one toast and one live timer while recording every notice', () => {
  const box = new Element(), records = [], timers = new Set(); let sequence = 0;
  const context = vm.createContext({ $: () => box, document: { createElement: () => new Element() }, notificationCenter: { record: text => records.push(text) },
    esc: String, theaterToastSeq: 0, theaterToastActions: new Map(), isTheater: false, theaterPost() {},
    setTimeout: () => { const id = ++sequence; timers.add(id); return id; }, clearTimeout: id => timers.delete(id) });
  vm.runInContext(source.slice(source.indexOf('function toast('), source.indexOf("window.addEventListener('message'", source.indexOf('function toast('))), context);
  for (let i = 0; i < 100; i++) context.toast('Notice ' + i);
  assert.equal(box.children.length, 1); assert.equal(timers.size, 1); assert.equal(records.length, 100);
});