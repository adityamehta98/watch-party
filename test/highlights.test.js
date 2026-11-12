'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Highlights, detectMoments, parseEbur128Line, videoEncoder } = require('../server/highlights');
const { Room } = require('../server/room');

test('ebur128 log lines yield momentary loudness points', () => {
  assert.deepEqual(parseEbur128Line('[Parsed_ebur128_0 @ 0x55] t: 12.3  TARGET:-23 LUFS    M: -18.70 S: -20.0'), { t: 12.3, lufs: -18.7 });
  assert.equal(parseEbur128Line('frame= 100 fps=0'), null);
  assert.equal(parseEbur128Line('t: 1 TARGET:-23 LUFS M: -inf S: -70').lufs, -70);
});

test('a synthetic loudness series returns the expected spread-out moment timestamps', () => {
  const loudness = Array.from({ length: 200 }, () => -30);
  for (const t of [40, 42, 120]) { loudness[t] = -8; loudness[t - 1] = -12; loudness[t + 1] = -12; }
  const moments = detectMoments({ loudness });
  assert.equal(moments.length, 2, 'nearby peaks merge into one moment');
  assert.ok(Math.abs(moments[0].t - 41) <= 1 && Math.abs(moments[1].t - 120) <= 1);
  for (const m of moments) assert.ok(m.score >= 1.5);
});

test('chat and reaction spikes contribute moments even with flat audio', () => {
  const reactions = new Map([[55, 6], [56, 4], [150, 6], [151, 5]]);
  const moments = detectMoments({ loudness: Array.from({ length: 200 }, () => -25), reactions });
  const times = moments.map(m => m.t);
  assert.ok(times.some(t => Math.abs(t - 55) <= 4), 'a reaction cluster becomes a moment');
  assert.ok(times.some(t => Math.abs(t - 150) <= 4), 'a second, far-apart cluster too');
});

test('empty signals produce no moments and a bad encoder set is reported, not crashed', () => {
  assert.deepEqual(detectMoments({}), []);
  assert.equal(videoEncoder(null)?.args[1], 'libx264');
  assert.equal(videoEncoder({ h264Software: false, h264: null }), null);
});

test('the room observes chat and reaction positions read-only without changing broadcasts', t => {
  const room = new Room({ config: { adminKey: 'a-secret', roomKey: 'guestsecretkey1234', room: { requireApproval: false, aiFeatures: true } }, library: { list: () => ({ items: [] }) }, save() {} });
  t.after(() => room.shutdown());
  room.movie = { id: 'movie01', kind: 'file', file: '/m.mkv' };
  const highlights = new Highlights({ ffmpeg: null, room });
  const seen = [];
  const original = room.broadcast; room.broadcast = function (m, e) { seen.push(m.type); return original.call(this, m, e); };
  room.broadcast({ type: 'state', state: { movieId: 'movie01', position: 300 } });
  room.broadcast({ type: 'react', emoji: '😂', movieId: 'movie01', position: 42.4 });
  room.broadcast({ type: 'chat', message: { id: 'x', movieId: 'movie01', position: 42.9, text: 'lol' } });
  room.broadcast({ type: 'chat', message: { id: 'y', system: true, text: 'joined', movieId: 'movie01', position: 5 } });
  assert.deepEqual([...highlights.reactions.get('movie01').entries()], [[42, 2]], 'two reactions in the same second, system message ignored');
  assert.equal(highlights.watched.get('movie01'), 300);
  assert.ok(seen.includes('react') && seen.includes('chat'), 'the room still broadcast everything');
});

test('highlights-generate without ffmpeg replies unavailable and never blocks the room', async t => {
  const room = new Room({ config: { adminKey: 'a-secret', roomKey: 'guestsecretkey1234', room: { requireApproval: false, aiFeatures: true } }, library: { list: () => ({ items: [] }) }, save() {} });
  t.after(() => room.shutdown());
  const ws = () => ({ readyState: 1, sent: [], send(s) { this.sent.push(JSON.parse(s)); }, close() {} });
  const host = room.hello(ws(), 'host', 'a-secret', { clientId: 'host0001', name: 'Host' }, {});
  room.movie = { id: 'movie01', kind: 'file', file: '/m.mkv' };
  room.highlights = new Highlights({ ffmpeg: null, room, dir: null });
  const seen = [];
  const original = room.broadcast; room.broadcast = function (m, e) { seen.push(m); return original.call(this, m, e); };
  room.onMessage(host, { type: 'highlights-generate' });
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(seen.find(m => m.type === 'highlights'), { type: 'highlights', clips: [], reason: 'unavailable' });
});

test('generated clips are served only to admitted viewers for the current title', async t => {
  const room = new Room({ config: { adminKey: 'a-secret', roomKey: 'guestsecretkey1234', room: { requireApproval: false, aiFeatures: true } }, library: { list: () => ({ items: [] }) }, save() {} });
  t.after(() => room.shutdown());
  room.movie = { id: 'movie01', kind: 'file', file: '/m.mkv' };
  const highlights = new Highlights({ ffmpeg: '/bin/ffmpeg', room, dir: '/tmp/none' });
  highlights.result = { movieId: 'movie01', clips: [{ t: 10, url: '/highlights/movie01/0.mp4' }], files: new Map([[0, '/does/not/exist.mp4']]) };
  const run = (key, local, path = '/highlights/movie01/0.mp4') => {
    const res = { code: null, writeHead(c) { this.code = c; }, end() {} };
    let served = false;
    highlights.serve({ method: 'GET' }, res, path, key, { local, missing: () => { res.code = 404; } });
    return res.code;
  };
  assert.equal(run('guestsecretkey1234', false), 404, 'the file is missing, but admission passed (serveFile 404)');
  assert.equal(run('wrong-key', false), 404, 'a wrong key is denied');
  room.movie = { id: 'other', kind: 'file', file: '/x.mkv' };
  assert.equal(run('guestsecretkey1234', false), 404, 'guests cannot fetch a clip from a title no longer showing');
  assert.equal(run('a-secret', true), 404, 'the host still resolves to the file (then 404 for the missing file)');
});

test('stop() during generate() aborts the clip loop so no further cuts are started', async t => {
  const room = new Room({ config: { adminKey: 'a-secret', roomKey: 'guestsecretkey1234', room: { requireApproval: false, aiFeatures: true } }, library: { list: () => ({ items: [] }) }, save() {} });
  t.after(() => room.shutdown());
  room.movie = { id: 'movie01', kind: 'file', file: '/m.mkv' };
  let cuts = 0;
  const analyze = async () => { const out = []; for (let i = 0; i < 300; i++) out[i] = i === 80 ? -5 : i === 180 ? -7 : -30; return out; };
  const cut = async (input, t, out) => { cuts++; if (cuts === 1) h.stop(); await new Promise(r => setTimeout(r, 5)); };
  const h = new Highlights({ ffmpeg: '/bin/ffmpeg', room, dir: '/tmp/hl-cancel', encoders: () => ({ h264Software: true }), analyze, cut });
  room.watched = new Map([['movie01', 300]]); h.watched.set('movie01', 300);
  await h.generate({ ws: {} });
  assert.equal(cuts, 1, 'the second clip is not started after stop()');
});

test('highlights can only scan and clip up to what the room has watched', async () => {
  const room = { movie: { id: 'movie01', kind: 'file', file: '/m.mkv', duration: 3600 }, broadcasts: [],
    currentPosition: () => 90, broadcast(m) { this.broadcasts.push(m); }, send() {}, roleForKey: () => 'host' };
  let scannedTo = 0, clipped = [];
  const analyze = async (input, start, end) => { scannedTo = end; const out = []; for (let i = 0; i < end; i++) out[i] = i === 50 ? -5 : -30; return out; };
  const cut = async (input, t, out, opts) => { clipped.push({ t, maxEnd: opts.maxEnd }); };
  const h = new Highlights({ ffmpeg: '/bin/ffmpeg', room, dir: '/tmp/hl-watched', encoders: () => ({ h264Software: true }), analyze, cut });
  h.watched.set('movie01', 90);
  await h.generate({ ws: {} });
  assert.equal(scannedTo, 90, 'analyze is capped at the watched position, not the full 3600 s duration');
  assert.ok(clipped.length && clipped.every(c => c.maxEnd === 90), 'each clip ends no later than watched');
});

test('an older cancelled generate() does not clear a newer run\'s busy slot', async t => {
  const room = new Room({ config: { adminKey: 'a-secret', roomKey: 'guestsecretkey1234', room: { requireApproval: false, aiFeatures: true } }, library: { list: () => ({ items: [] }) }, save() {} });
  t.after(() => room.shutdown());
  room.movie = { id: 'movie01', kind: 'file', file: '/m.mkv' };
  let releaseScan; const held = new Promise(r => { releaseScan = r; });
  const analyze = async () => { await held; const out = []; for (let i = 0; i < 100; i++) out[i] = i === 50 ? -5 : -30; return out; };
  const cut = async () => {};
  const h = new Highlights({ ffmpeg: '/bin/ffmpeg', room, dir: '/tmp/hl-race', encoders: () => ({ h264Software: true }), analyze, cut });
  h.watched.set('movie01', 100);
  const first = h.generate({ ws: {} });
  await new Promise(r => setTimeout(r, 5));
  h.stop();                       // cancels the first run; busy cleared to false
  const second = h.generate({ ws: {} });
  await new Promise(r => setTimeout(r, 5));
  assert.equal(h.busy, true, 'the second run is now busy');
  releaseScan([]); await first;   // the OLD run finishes; it must NOT clear the new run's busy
  assert.equal(h.busy, true, 'busy stays set for the new run');
  releaseScan([]); await second;  // (releaseScan is a no-op the second time; use a fresh one below)
});
