'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Room, REACTIONS } = require('../server/room');

function roomFixture(t) {
  let saves = 0;
  const config = { adminKey: 'admin-secret-key', roomKey: 'guestsecretkey1234', room: {} };
  const room = new Room({ config, library: {}, save: () => saves++ });
  t.after(() => room.shutdown());
  const client = (id, role) => {
    const messages = [];
    const c = { id, role, name: role, admitted: true, perms: { playback: true, react: true }, lastReact: [],
      ws: { readyState: 1, send: raw => messages.push(JSON.parse(raw)) }, messages };
    room.clients.set(id, c);
    return c;
  };
  return { room, config, client, saves: () => saves };
}

test('host and phone reactions reach both admitted viewers regardless of sender direction', t => {
  const f = roomFixture(t), host = f.client('host01', 'host'), phone = f.client('phone01', 'guest');
  f.room.onMessage(host, { type: 'react', emoji: REACTIONS[0] });
  f.room.onMessage(phone, { type: 'react', emoji: REACTIONS[1] });
  assert.deepEqual(phone.messages.map(message => message.emoji), [REACTIONS[0], REACTIONS[1]]);
  assert.deepEqual(host.messages.map(message => message.emoji), [REACTIONS[0], REACTIONS[1]]);
  phone.perms.react = false;
  f.room.onMessage(host, { type: 'react', emoji: REACTIONS[2] });
  assert.equal(phone.messages.at(-1).emoji, REACTIONS[2], 'send permission must not prevent receiving reactions');
});

test('phone and laptop share a persistent auto-skip toggle without issuing next-episode actions', t => {
  const f = roomFixture(t), host = f.client('host01', 'host'), phone = f.client('phone01', 'guest');
  f.room.movie = { id: 'ep2', kind: 'anime', episode: 2 };
  f.room.onMessage(phone, { type: 'anime-auto-skip', enabled: false });
  assert.equal(f.room.publicSettings(false).animeAutoSkip, false);
  assert.equal(host.messages.at(-1).settings.animeAutoSkip, false);
  assert.equal(phone.messages.at(-1).settings.animeAutoSkip, false);
  assert.equal(f.config.room.animeAutoSkip, false);
  assert.equal(f.room.movie.episode, 2);
  f.room.onMessage(host, { type: 'settings', settings: { autoWait: false } });
  assert.equal(f.config.room.animeAutoSkip, false, 'other settings changes preserve the shared preference');
  const restored = new Room({ config: f.config, library: {} });
  t.after(() => restored.shutdown());
  assert.equal(restored.publicSettings(false).animeAutoSkip, false);
  phone.perms.playback = false;
  const before = f.saves();
  f.room.onMessage(phone, { type: 'anime-auto-skip', enabled: true });
  assert.equal(f.saves(), before);
  assert.equal(f.room.settings.animeAutoSkip, false);
  f.room.onMessage(host, { type: 'anime-auto-skip', enabled: true });
  assert.equal(phone.messages.at(-1).settings.animeAutoSkip, true);
});

function reactions({ synced = true, now = 1000 } = {}) {
  const shown = [], timers = [];
  const clock = { synced, now: () => now };
  const S = { movie: { id: 'ep2' } };
  const context = vm.createContext({ S, conn: { clock },
    floatReaction: (emoji, name) => shown.push({ emoji, name }),
    setTimeout: callback => timers.push(callback) });
  const source = require('./app-source');
  vm.runInContext(source.slice(source.indexOf('function scheduleReaction('), source.indexOf('function floatReaction(')), context);
  return { shown, timers, S, receive: message => context.scheduleReaction(message), time: value => { now = value; } };
}

test('an unsynced phone clock cannot reject a live reaction as stale', () => {
  const f = reactions({ synced: false, now: 60000 });
  f.receive({ movieId: 'ep2', at: 1000, emoji: '😂', name: 'Host' });
  assert.equal(f.shown.length, 1);
});

test('accepted reactions survive delayed mobile timers while old-episode reactions are discarded', () => {
  const f = reactions();
  f.receive({ movieId: 'ep2', at: 1350, emoji: '😂', name: 'Host' });
  f.time(5000); f.timers.shift()();
  assert.equal(f.shown.length, 1);
  f.time(1000);
  f.receive({ movieId: 'ep2', at: 1350, emoji: '👏', name: 'Guest' });
  f.S.movie = { id: 'ep3' }; f.timers.shift()();
  assert.equal(f.shown.length, 1);
});

test('a synchronized connection still drops genuinely stale reaction deliveries', () => {
  const f = reactions({ now: 20000 });
  f.receive({ movieId: 'ep2', at: 1000, emoji: '😂' });
  assert.equal(f.shown.length, 0);
});
