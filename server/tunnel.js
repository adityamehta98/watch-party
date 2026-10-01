'use strict';
// Runs a free Cloudflare "quick tunnel" so friends can reach this PC over https without router setup.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

class Tunnel extends EventEmitter {
  constructor(bin, port) {
    super();
    this.bin = bin;
    this.port = port;
    this.url = null;
    this.status = bin ? 'starting' : 'missing';
    this.lastLog = '';
    this.proc = null;
    this.stopped = false;
    this.backoff = 3000;
  }

  start() {
    if (!this.bin || this.stopped) return;
    this.status = 'starting';
    this.emit('change');
    const p = spawn(this.bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${this.port}`], { windowsHide: true });
    this.proc = p;
    const onData = d => {
      const text = String(d);
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        if (/ERR|error|failed/i.test(line)) this.lastLog = line.replace(/^\S+\s+/, '').slice(0, 300);
        const m = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (m && m[0] !== this.url) {
          this.url = m[0];
          this.status = 'connecting';
          this.emit('change');
        }
        if (/Registered tunnel connection/i.test(line) && this.status !== 'up') {
          this.status = 'up';
          this.backoff = 3000;
          this.emit('change');
        }
      }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', e => { this.lastLog = String(e); });
    p.on('close', () => {
      this.proc = null;
      this.url = null;
      if (this.stopped) return;
      this.status = 'down';
      this.emit('change');
      setTimeout(() => this.start(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 60000);
    });
  }

  restart() {
    if (this.proc) { try { this.proc.kill(); } catch {} } else this.start();
  }

  stop() {
    this.stopped = true;
    if (this.proc) { try { this.proc.kill(); } catch {} }
  }
}

module.exports = { Tunnel };
