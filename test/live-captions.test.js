'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { LiveCaptioner, segmentsToCues, cuesToVtt, wavFromPcm, extractPcm } = require('../server/live-captions');
const { Room } = require('../server/room');
const { resolveProvider, transcribeHf, makeTranscriber } = require('../server/live-captions');

const fakeRoom = (movie, position = 0) => ({ movie, sent: [], broadcasts: [], currentPosition: () => position,
  broadcast(msg) { this.broadcasts.push(msg); }, send(ws, msg) { this.sent.push({ ws, msg }); } });
const loudPcm = seconds => { const b = Buffer.alloc(seconds * 16000 * 2); for (let i = 0; i < b.length; i += 2) b.writeInt16LE(Math.round(Math.sin(i / 20) * 8000), i); return b; };

test('transcript segments become well-formed WebVTT cues offset by the window start', () => {
  const cues = segmentsToCues([{ start: 0.5, end: 3, text: ' Hello there ' }, { start: 3.2, end: 5.75, text: 'General --> Kenobi' },
    { start: 6, end: 8, text: 'Thanks for watching', no_speech_prob: 0.9 }, { start: 9, end: 9.1, text: '   ' }], 24);
  assert.deepEqual(cues, [{ start: 24.5, end: 27, text: 'Hello there' }, { start: 27.2, end: 29.75, text: 'General -> Kenobi' }]);
  const vtt = cuesToVtt(cues);
  assert.equal(vtt, 'WEBVTT\n\n00:00:24.500 --> 00:00:27.000\nHello there\n\n00:00:27.200 --> 00:00:29.750\nGeneral -> Kenobi\n');
  assert.match(cuesToVtt([{ start: 3725.004, end: 3726, text: 'x' }]), /01:02:05\.004 --> 01:02:06\.000/);
});

test('start() is a quiet no-op that reports unavailable when ffmpeg or the key is missing', () => {
  for (const options of [{ ffmpeg: null, sttKey: 'key' }, { ffmpeg: '/bin/ffmpeg', sttKey: '' }]) {
    const room = fakeRoom({ id: 'm1', kind: 'file', file: '/movie.mkv' });
    const captioner = new LiveCaptioner({ ...options, room, extract: () => { throw Error('must not run'); } });
    assert.equal(captioner.start(), false);
    assert.equal(captioner.active, false);
    assert.deepEqual(room.broadcasts, [{ type: 'captions-status', ok: false, active: false, reason: 'unavailable' }]);
  }
});

test('windows ahead of the playhead are transcribed, broadcast, saved as VTT and replayed to late joiners', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-live-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const room = fakeRoom({ id: 'movie01', kind: 'file', file: '/movie.mkv', duration: 600 }, 13);
  const asked = [];
  const captioner = new LiveCaptioner({ ffmpeg: '/bin/ffmpeg', sttKey: 'key', room, dir, tickMs: 60000,
    extract: async (input, start, seconds) => { asked.push({ input, start, seconds }); return loudPcm(2); },
    transcribe: async wav => { assert.equal(wav.subarray(0, 4).toString(), 'RIFF'); return [{ start: 1, end: 2.5, text: `Line ${asked.length}` }]; } });
  t.after(() => captioner.stop());
  assert.equal(captioner.start(), true);
  assert.equal(captioner.start(), true, 'idempotent');
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(asked[0], { input: '/movie.mkv', start: 12, seconds: 12 });
  const live = room.broadcasts.find(m => m.type === 'live-caption' && m.cues.length);
  assert.deepEqual(live, { type: 'live-caption', movieId: 'movie01', cues: [{ start: 13, end: 14.5, text: 'Line 1' }] });
  captioner.tick(); await new Promise(r => setTimeout(r, 20));
  assert.equal(asked[1].start, 24, 'then the next window');
  await captioner.flush();
  assert.equal(fs.readFileSync(path.join(dir, 'movie01.live.vtt'), 'utf8'), 'WEBVTT\n\n00:00:13.000 --> 00:00:14.500\nLine 1\n\n00:00:25.000 --> 00:00:26.500\nLine 2\n');
  captioner.sync({ ws: 'late' });
  assert.deepEqual(room.sent.map(s => s.msg.type), ['captions-status', 'live-caption']);
  assert.equal(room.sent[1].msg.cues.length, 2);
  assert.deepEqual(captioner.transcriptUntil(20), [{ t: 13, text: 'Line 1' }], 'no spoilers past the playhead');
});

test('silent audio is never sent for transcription and streaming services are reported unsupported', async () => {
  let calls = 0;
  const room = fakeRoom({ id: 'm2', kind: 'file', file: '/quiet.mkv', duration: 60 }, 0);
  const captioner = new LiveCaptioner({ ffmpeg: 'ffmpeg', sttKey: 'key', room, tickMs: 60000, extract: async () => Buffer.alloc(32000 * 4), transcribe: async () => { calls++; return []; } });
  captioner.start(); await new Promise(r => setTimeout(r, 10));
  assert.equal(calls, 0); assert.equal(captioner.done.has(0), true);
  room.movie = { id: 'n1', kind: 'service', service: 'netflix' };
  captioner.tick();
  assert.equal(room.broadcasts.at(-1).reason, 'unsupported');
  captioner.stop();
});

test('the room only lets the host start captions and never changes playback state', t => {
  const room = new Room({ config: { adminKey: 'admin-secret', roomKey: 'guestsecretkey1234', room: { requireApproval: false, aiFeatures: true } }, library: { list: () => ({ items: [] }) } });
  t.after(() => room.shutdown());
  const ws = () => ({ readyState: 1, sent: [], send(s) { this.sent.push(JSON.parse(s)); }, close() {} });
  const host = room.hello(ws(), 'host', 'admin-secret', { clientId: 'host0001', name: 'Host' }, {});
  const guest = room.hello(ws(), 'guest', 'guestsecretkey1234', { clientId: 'guest001', name: 'Guest' }, { session: 's' });
  const calls = [];
  room.liveCaptioner = { start: () => calls.push('start'), stop: () => calls.push('stop'), sync: c => calls.push('sync:' + c.id) };
  const before = { ...room.state };
  room.onMessage(guest, { type: 'captions-start' });
  room.onMessage(host, { type: 'captions-start' });
  room.onMessage(guest, { type: 'captions-sync' });
  room.onMessage(guest, { type: 'captions-stop' });
  room.onMessage(host, { type: 'captions-stop' });
  assert.deepEqual(calls, ['start', 'sync:guest001', 'stop']);
  assert.deepEqual(room.state, before);
});

const ffmpeg = spawnSync('ffmpeg', ['-hide_banner', '-version']).status === 0 ? 'ffmpeg' : null;
test('ffmpeg extraction returns exactly one window of 16 kHz mono PCM', { skip: !ffmpeg && 'ffmpeg not installed' }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-live-ff-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'tone.wav');
  fs.writeFileSync(file, wavFromPcm(loudPcm(30)));
  const pcm = await extractPcm(ffmpeg, file, 12, 12);
  assert.equal(pcm.length, 12 * 16000 * 2);
  const tail = await extractPcm(ffmpeg, file, 24, 12);
  assert.equal(tail.length, 6 * 16000 * 2, 'the last window is shorter');
});

test('provider resolution prefers a Hugging Face token, falls back to Groq, and reuses the token for recap', () => {
  assert.equal(resolveProvider({ env: {}, config: {} }).name, 'hf');
  const hf = resolveProvider({ env: { HF_TOKEN: 'hf_abc' }, config: {} });
  assert.deepEqual([hf.provider, hf.name, hf.key, hf.llmKey], ['hf', 'hf', 'hf_abc', 'hf_abc']);
  assert.match(hf.sttUrl, /router\.huggingface\.co\/hf-inference\/models\//);
  const groq = resolveProvider({ env: { WATCHPARTY_STT_KEY: 'gsk_1' }, config: {} });
  assert.deepEqual([groq.provider, groq.name, groq.llmModel], ['openai', 'groq', 'llama-3.3-70b-versatile']);
  const forced = resolveProvider({ env: { WATCHPARTY_AI_PROVIDER: 'openai', WATCHPARTY_LLM_KEY: 'k' }, config: {} });
  assert.equal(forced.provider, 'openai');
});

test('the Hugging Face transcriber sends base64 audio and maps timestamped chunks to segments', async () => {
  let sent;
  const fetchFn = async (url, init) => { sent = { url, body: JSON.parse(init.body), auth: init.headers.Authorization }; return { ok: true, json: async () => ({ text: 'hi', chunks: [{ text: 'Hello', timestamp: [0, 1.5] }, { text: 'world', timestamp: [1.5, null] }] }) }; };
  const call = makeTranscriber({ provider: 'hf', key: 'hf_tok', url: 'https://api-inference.huggingface.co/models/', model: 'openai/whisper-large-v3', fetchFn });
  const segments = await call(Buffer.from('AUDIO'));
  assert.equal(sent.auth, 'Bearer hf_tok');
  assert.match(sent.url, /models\/openai\/whisper-large-v3$/);
  assert.equal(sent.body.inputs, Buffer.from('AUDIO').toString('base64'));
  assert.equal(sent.body.parameters.return_timestamps, true);
  assert.deepEqual(segments, [{ start: 0, end: 1.5, text: 'Hello' }, { start: 1.5, end: 12, text: 'world' }]);
});

test('AI messages do nothing until the host enables AI features in room settings', t => {
  const room = new Room({ config: { adminKey: 'admin-secret', roomKey: 'guestsecretkey1234', room: { requireApproval: false } }, library: { list: () => ({ items: [] }) }, save() {} });
  t.after(() => room.shutdown());
  const ws = () => ({ readyState: 1, sent: [], send(s) { this.sent.push(JSON.parse(s)); }, close() {} });
  const host = room.hello(ws(), 'host', 'admin-secret', { clientId: 'host0001', name: 'Host' }, {});
  const calls = [];
  room.liveCaptioner = { start: () => calls.push('start'), stop: () => calls.push('stop'), sync() {} };
  room.highlights = { generate: () => calls.push('hl'), stop: () => calls.push('hl-stop') };
  room.onMessage(host, { type: 'captions-start' });
  room.onMessage(host, { type: 'highlights-generate' });
  assert.deepEqual(calls, [], 'off by default');
  room.onMessage(host, { type: 'settings', settings: { aiFeatures: true } });
  room.onMessage(host, { type: 'captions-start' });
  room.onMessage(host, { type: 'highlights-generate' });
  assert.deepEqual(calls, ['start', 'hl']);
  room.onMessage(host, { type: 'settings', settings: { aiFeatures: false } });
  assert.ok(calls.includes('stop') && calls.includes('hl-stop'), 'disabling stops running features');
  assert.equal(room.publicSettings(false).aiFeatures, false);
});

test('a window still extracting when the captioner stops and starts again does not transcribe', async t => {
  const pcm2 = loudPcm(1);
  let releaseFirst; const firstPcm = new Promise(r => { releaseFirst = r; });
  const calls = [];
  const room = { movie: { id: 'movie01', kind: 'file', file: '/m.mkv', duration: 600 }, broadcasts: [], sent: [],
    currentPosition: () => 0, broadcast(m) { this.broadcasts.push(m); }, send(ws, m) { this.sent.push(m); } };
  const captioner = new LiveCaptioner({ ffmpeg: 'ffmpeg', sttKey: 'k', room, tickMs: 60000,
    extract: async () => { const n = calls.filter(x => x === 'extract').length + 1; calls.push('extract'); return n === 1 ? firstPcm : pcm2; },
    transcribe: async () => { calls.push('transcribe'); return [{ start: 0, end: 1, text: 'hi' }]; } });
  t.after(() => captioner.stop());
  captioner.start();                 // runId = 1 → run() awaits firstPcm
  await new Promise(r => setTimeout(r, 5));
  captioner.stop();                  // runId = 2, clears inflight
  captioner.start();                 // runId = 3 → run() awaits pcm2 and transcribes
  await new Promise(r => setTimeout(r, 25));
  releaseFirst(loudPcm(1));          // old extraction finishes
  await new Promise(r => setTimeout(r, 25));
  // Only one transcribe call came from the live (runId=3) run; the stale (runId=1) one dropped.
  assert.equal(calls.filter(c => c === 'transcribe').length, 1);
});


test('inflight slot ownership is preserved across runId changes: an old finally does not clear a new run', async t => {
  let release1; const first = new Promise(r => { release1 = r; });
  const calls = [];
  const room = { movie: { id: 'movie01', kind: 'file', file: '/m.mkv', duration: 600 }, broadcasts: [], sent: [],
    currentPosition: () => 0, broadcast() {}, send() {} };
  const captioner = new LiveCaptioner({ ffmpeg: 'ffmpeg', sttKey: 'k', room, tickMs: 60000,
    extract: async () => { const n = calls.push('extract'); return n === 1 ? first : loudPcm(1); },
    transcribe: async () => { calls.push('transcribe'); return [{ start: 0, end: 1, text: 'x' }]; } });
  t.after(() => captioner.stop());
  captioner.start();                               // first run captures runId A, awaits
  await new Promise(r => setTimeout(r, 5));
  captioner.stop();                                // runId bumps
  captioner.start();                               // runId C, inflight(0) now owned by C
  await new Promise(r => setTimeout(r, 25));       // let the new run reach transcribe + done
  const inflightCount = captioner.inflight.size;   // new run has already completed window 0
  release1(loudPcm(1));                            // old run resumes, must not delete the new run's slot
  await new Promise(r => setTimeout(r, 25));
  assert.ok(captioner.done.has(0), 'the new run marked window 0 as done');
  assert.equal(calls.filter(c => c === 'transcribe').length, 1, 'only the new run reaches transcribe');
});
