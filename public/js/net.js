// WebSocket connection with auto-reconnect, plus a clock synced to the server's clock.

export class Clock {
  constructor() { this.offset = 0; this.samples = []; this.synced = false; }
  static local() { return performance.timeOrigin + performance.now(); }
  sample(t0, ts, t1) {
    const rtt = t1 - t0;
    if (rtt < 0 || rtt > 10000) return;
    this.samples.push({ rtt, off: ts - (t0 + t1) / 2 });
    if (this.samples.length > 12) this.samples.shift();
    // trust the lowest-latency samples most
    const best = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, 4);
    this.offset = best.reduce((s, x) => s + x.off, 0) / best.length;
    this.rtt = best[0].rtt;
    this.synced = this.samples.length >= 3;
  }
  now() { return Clock.local() + this.offset; }
}

export class Connection {
  constructor(key, helloFn) {
    this.key = key;
    this.helloFn = helloFn;
    this.handlers = new Map();
    this.clock = new Clock();
    this.ws = null;
    this.retry = 0;
    this.closedForGood = false;
    this.pingTimer = null;
  }
  on(type, fn) { if (!this.handlers.has(type)) this.handlers.set(type, []); this.handlers.get(type).push(fn); return this; }
  emit(type, data) { for (const fn of this.handlers.get(type) || []) { try { fn(data); } catch (e) { console.error(e); } } }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws?k=${encodeURIComponent(this.key)}`);
    this.ws = ws;
    this.emit('status', 'connecting');
    ws.onopen = () => {
      this.retry = 0;
      this.send(this.helloFn());
      this.emit('status', 'open');
      this.startPings();
    };
    ws.onmessage = ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'pong') { this.clock.sample(msg.t0, msg.ts, Clock.local()); this.emit('clock', this.clock); return; }
      this.emit(msg.type, msg);
      this.emit('*', msg);
    };
    ws.onclose = ev => {
      clearInterval(this.pingTimer);
      if (this.ws !== ws) return;
      if (ev.code >= 4000 && ev.code < 4010 && ev.code !== 4000 && ev.code !== 4005) { this.closedForGood = true; this.emit('fatal', ev.code); return; }
      if (ev.code === 4000) { this.closedForGood = true; this.emit('fatal', ev.code); return; } // opened in another tab
      if (this.closedForGood) return;
      this.emit('status', 'reconnecting');
      const delay = Math.min(1000 * 2 ** this.retry, 10000);
      this.retry++;
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => {};
  }

  startPings() {
    clearInterval(this.pingTimer);
    let n = 0;
    const ping = () => this.send({ type: 'ping', t0: Clock.local() });
    // burst at start for a quick, accurate estimate, then every few seconds
    const burst = setInterval(() => { ping(); if (++n >= 6) clearInterval(burst); }, 150);
    this.pingTimer = setInterval(ping, 3000);
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }
}
