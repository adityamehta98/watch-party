'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Recap, transcriptText } = require('../server/recap');
const { Room } = require('../server/room');

function fixture(t, { llmKey = 'llm-key', lines = [{ t: 5, text: 'Ana finds the map.' }, { t: 70, text: 'They leave the city at night.' }], reply = 'Ana found a map and the group left the city.' } = {}) {
  const room = new Room({ config: { adminKey: 'admin-secret', roomKey: 'guestsecretkey1234', room: { requireApproval: false, aiFeatures: true } }, library: { list: () => ({ items: [] }) } });
  t.after(() => room.shutdown());
  const ws = () => ({ readyState: 1, sent: [], send(s) { this.sent.push(JSON.parse(s)); }, close() {} });
  const host = room.hello(ws(), 'host', 'admin-secret', { clientId: 'host0001', name: 'Host' }, {});
  const late = room.hello(ws(), 'guest', 'guestsecretkey1234', { clientId: 'late0001', name: 'Late' }, { session: 'late' });
  const other = room.hello(ws(), 'guest', 'guestsecretkey1234', { clientId: 'other001', name: 'Other' }, { session: 'other' });
  room.movie = { id: 'movie01', kind: 'file', title: 'The Map' };
  room.state = { ...room.state, movieId: 'movie01', position: 80, playing: false };
  const requests = [];
  const fetch = async (url, init) => { requests.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization }); return { ok: true, json: async () => ({ choices: [{ message: { content: reply } }] }) }; };
  room.recap = new Recap({ room, captioner: { movieId: 'movie01', transcriptUntil: () => lines }, llmKey, fetch });
  for (const c of [host, late, other]) c.ws.sent.length = 0;
  return { room, host, late, other, requests };
}

test('recap-request answers only the person who asked, with a summary of the transcript so far', async t => {
  const f = fixture(t);
  let broadcasts = 0; const original = f.room.broadcast; f.room.broadcast = function (...a) { broadcasts++; return original.apply(this, a); };
  f.room.onMessage(f.late, { type: 'recap-request' });
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(f.late.ws.sent, [{ type: 'recap', text: 'Ana found a map and the group left the city.', upTo: 80, movieId: 'movie01' }]);
  assert.deepEqual(f.other.ws.sent, []); assert.deepEqual(f.host.ws.sent, []);
  assert.equal(broadcasts, 0);
  assert.equal(f.requests[0].auth, 'Bearer llm-key');
  assert.match(f.requests[0].body.messages[0].content, /3-4 sentences, only facts from the transcript/);
  assert.match(f.requests[0].body.messages[1].content, /\[0:05\] Ana finds the map\.\n\[1:10\] They leave the city at night\./);
  f.room.onMessage(f.late, { type: 'recap-request' });
  assert.deepEqual(f.late.ws.sent.at(-1), { type: 'recap', text: '', reason: 'busy' });
});

test('no transcript yet or no key replies unavailable without calling the model', async t => {
  for (const options of [{ lines: [] }, { llmKey: '' }]) {
    const f = fixture(t, options);
    await f.room.recap.request(f.late);
    assert.deepEqual(f.late.ws.sent, [{ type: 'recap', text: '', reason: 'unavailable' }]);
    assert.equal(f.requests.length, 0);
  }
});

test('long transcripts keep the opening and the most recent lines', () => {
  const lines = Array.from({ length: 2000 }, (_, i) => ({ t: i * 3, text: `line ${i} ` + 'x'.repeat(40) }));
  const text = transcriptText(lines, 6000);
  assert.ok(text.length <= 6200);
  assert.match(text, /^\[0:00\] line 0 /);
  assert.match(text, /\[\.\.\.\]/);
  assert.match(text, /line 1999 x+$/);
});

test('a summary that finishes after the movie changes is dropped as stale', async t => {
  let release; const held = new Promise(r => { release = r; });
  const f = fixture(t, { reply: 'Delayed summary.' });
  f.room.recap.fetch = async () => { await held; return { ok: true, json: async () => ({ choices: [{ message: { content: 'Delayed summary.' } }] }) }; };
  const pending = f.room.recap.request(f.late);
  f.room.movie = { id: 'movie02', kind: 'file', title: 'Other' };
  release();
  await pending;
  const last = f.late.ws.sent.at(-1);
  assert.equal(last.text, '');
  assert.equal(last.reason, 'stale');
});
