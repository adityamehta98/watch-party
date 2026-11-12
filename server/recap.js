'use strict';
// "Catch me up": a short summary of what has been said so far, for someone who joined late.
// Built from the live-caption transcript up to the room's playhead and sent only to the person who asked.
const LLM_URL = 'https://api.groq.com/openai/v1/chat/completions';
const LLM_MODEL = 'llama-3.3-70b-versatile';
const PROMPT = 'Summarize what has happened so a late joiner is caught up, 3-4 sentences, only facts from the transcript. ' +
  'Write plain sentences with no headings, lists or quotes. If the transcript is too thin to tell, say so in one sentence.';
const MAX_CHARS = 14000;

const stamp = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

// Keep the start and the most recent part when a long transcript has to be shortened.
function transcriptText(lines, max = MAX_CHARS) {
  const all = lines.map(l => `[${stamp(l.t)}] ${l.text}`);
  let text = all.join('\n');
  if (text.length <= max) return text;
  const head = [], tail = [];
  let size = 0;
  for (let i = 0; i < all.length && size < max * 0.25; i++) { head.push(all[i]); size += all[i].length + 1; }
  for (let i = all.length - 1; i >= head.length && size < max; i--) { tail.unshift(all[i]); size += all[i].length + 1; }
  return [...head, '[...]', ...tail].join('\n');
}

class Recap {
  constructor({ room, captioner, llmKey, fetch: fetchFn = fetch, url, model, cooldownMs = 8000 } = {}) {
    this.room = room;
    this.captioner = captioner;
    this.llmKey = String(llmKey || '').trim();
    this.fetch = fetchFn;
    this.url = url || process.env.WATCHPARTY_LLM_URL || LLM_URL;
    this.model = model || process.env.WATCHPARTY_LLM_MODEL || LLM_MODEL;
    this.cooldownMs = cooldownMs;
    this.last = new Map(); // client id -> last request time
  }

  reply(client, msg) { this.room.send(client.ws, { type: 'recap', ...msg }); }

  async request(client) {
    const movie = this.room.movie;
    const lines = movie && this.captioner?.movieId === movie.id ? this.captioner.transcriptUntil() : [];
    if (!this.llmKey || !lines.length) return this.reply(client, { text: '', reason: 'unavailable' });
    const now = Date.now();
    if (now - (this.last.get(client.id) || 0) < this.cooldownMs) return this.reply(client, { text: '', reason: 'busy' });
    this.last.set(client.id, now);
    if (this.last.size > 500) this.last.delete(this.last.keys().next().value);
    const upTo = Math.round(this.room.currentPosition());
    const movieId = movie.id;
    try {
      const res = await this.fetch(this.url, {
        method: 'POST', signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${this.llmKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, temperature: 0.2, max_tokens: 320, messages: [
          { role: 'system', content: PROMPT },
          { role: 'user', content: `Title: ${movie.title || 'Untitled'}\nTranscript so far, timestamps in minutes:seconds:\n${transcriptText(lines)}` },
        ] }),
      });
      if (!res.ok) throw new Error(`summary failed (${res.status})`);
      const body = await res.json();
      const text = String(body?.choices?.[0]?.message?.content || '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, 1500);
      if (!text) throw new Error('empty summary');
      if (client.closed) return;
      // The movie may have changed while the summary was being generated; drop a stale reply.
      if (this.room.movie?.id !== movieId) return this.reply(client, { text: '', reason: 'stale' });
      this.reply(client, { text, upTo, movieId });
    } catch (error) {
      console.warn('  ! Catch me up:', error.message);
      if (!client.closed) this.reply(client, { text: '', reason: 'failed' });
    }
  }
}

module.exports = { Recap, transcriptText };
