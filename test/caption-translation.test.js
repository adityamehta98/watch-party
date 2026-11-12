'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { resolveProvider, makeTranscriber, LiveCaptioner } = require('../server/live-captions');
test('English captions choose the multilingual Groq translation model and auto-detect input', async () => {
  const p = resolveProvider({ env: {}, config: { hfToken: 'hf_fake', sttKey: 'gsk_fake', sttLanguage: 'en' } });
  assert.equal(p.name, 'groq'); assert.equal(p.sttModel, 'whisper-large-v3'); assert.match(p.sttUrl, /audio\/translations$/);
  const calls = [];
  const call = makeTranscriber({ ...p, key: p.key, url: p.sttUrl, model: p.sttModel, fetchFn: async (url, init) => {
    calls.push({ url, form: init.body });
    return { ok: true, json: async () => ({ segments: [{ start: 1.2, end: 3.4, text: 'Where are you going?' }] }) };
  } });
  assert.equal((await call(Buffer.from('synthetic audio')))[0].text, 'Where are you going?');
  assert.equal(calls[0].form.has('language'), false); assert.equal(calls[0].form.get('model'), 'whisper-large-v3');
});
test('original-language output remains available without forcing English', () => {
  const p = resolveProvider({ env: {}, config: { sttKey: 'gsk_fake', captionOutput: 'original', sttLanguage: 'hi' } });
  assert.equal(p.translate, false); assert.equal(p.language, 'hi'); assert.match(p.sttUrl, /audio\/transcriptions$/);
});
test('HF translates Hindi and mixed-language subtitle segments together and preserves timing', async () => {
  let calls = 0;
  const call = makeTranscriber({ provider: 'hf', translate: true, key: 'fake', url: 'https://router.huggingface.co/hf-inference/models/', model: 'whisper', llmUrl: 'https://router.huggingface.co/v1/chat/completions', llmKey: 'fake', llmModel: 'model',
    fetchFn: async (_, init) => {
      calls++;
      if (calls === 1) return { ok: true, json: async () => ({ chunks: [{ text: 'तुम कहाँ जा रहे हो?', timestamp: [1, 3] }, { text: 'Okay, मैं आ रहा हूँ।', timestamp: [4, 6] }] }) };
      const body = JSON.parse(init.body); assert.match(body.messages[1].content, /तुम/);
      return { ok: true, json: async () => ({ choices: [{ message: { content: '["Where are you going?", "Okay, I am coming."]' } }] }) };
    } });
  assert.deepEqual(await call(Buffer.from('synthetic')), [{ start: 1, end: 3, text: 'Where are you going?' }, { start: 4, end: 6, text: 'Okay, I am coming.' }]);
});
test('exhausted provider credits stop transcription instead of repeatedly retrying', async t => {
  const room = { movie: { id: 'm', kind: 'file', file: '/synthetic', duration: 60 }, currentPosition: () => 0, broadcast() {} };
  const pcm = Buffer.alloc(32000); for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(8000, i);
  const c = new LiveCaptioner({ ffmpeg: 'stub', sttKey: 'fake', room, extract: async () => pcm, transcribe: async () => { throw Object.assign(new Error('credits'), { status: 402 }); } });
  t.after(() => c.stop()); c.start(); await new Promise(r => setImmediate(r));
  assert.equal(c.active, false); assert.equal(c.reason, 'credits');
});
