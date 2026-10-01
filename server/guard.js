'use strict';
// Front-door protection for the one port the app opens to the internet.
// - Anyone who doesn't have the secret invite link just gets "not found" (the app stays invisible).
// - Too many wrong attempts from one internet address: that address is blocked for an hour.
// - Limits on connections per address and on how long a silent connection may stay open.
const net = require('net');

const norm = ip => String(ip || '').replace(/^::ffff:/, '');
const isLoopback = ip => /^(127\.|::1$)/.test(norm(ip));
function isLan(ip) {
  const a = norm(ip);
  if (!net.isIPv4(a)) return /^f[cd]/i.test(a) || /^fe80/i.test(a);
  const p = a.split('.').map(Number);
  return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168);
}

class Guard {
  constructor({ maxStrikes = 10, windowMs = 10 * 60e3, blockMs = 60 * 60e3, maxConnPerIp = 64, log = () => {} } = {}) {
    Object.assign(this, { maxStrikes, windowMs, blockMs, maxConnPerIp, log });
    this.strikes = new Map();  // ip -> [timestamps]
    this.blocked = new Map();  // ip -> until
    this.conns = new Map();    // ip -> open connection count
    setInterval(() => this.sweep(), 60e3).unref();
  }

  // never block this PC or devices on your own home network
  exempt(ip) { return !process.env.WP_TEST_NO_EXEMPT && (isLoopback(ip) || isLan(ip)); }

  isBlocked(ip) {
    ip = norm(ip);
    const until = this.blocked.get(ip);
    if (!until) return false;
    if (until < Date.now()) { this.blocked.delete(ip); return false; }
    return true;
  }

  // called for each new TCP connection; returns false if it must be dropped
  admit(sock) {
    const ip = norm(sock.remoteAddress);
    if (this.isBlocked(ip)) return false;
    const n = (this.conns.get(ip) || 0) + 1;
    if (n > this.maxConnPerIp && !this.exempt(ip)) return false;
    this.conns.set(ip, n);
    sock.once('close', () => {
      const c = (this.conns.get(ip) || 1) - 1;
      if (c <= 0) this.conns.delete(ip); else this.conns.set(ip, c);
    });
    return true;
  }

  strike(ip, reason) {
    ip = norm(ip);
    if (this.exempt(ip)) return;
    const now = Date.now();
    const list = (this.strikes.get(ip) || []).filter(t => now - t < this.windowMs);
    list.push(now);
    this.strikes.set(ip, list);
    if (list.length >= this.maxStrikes && !this.isBlocked(ip)) {
      this.blocked.set(ip, now + this.blockMs);
      this.strikes.delete(ip);
      this.log(`  Blocked ${ip} for 1 hour (${list.length} wrong attempts, last: ${reason}).`);
    }
  }

  list() {
    const now = Date.now();
    return [...this.blocked.entries()].filter(([, t]) => t > now).map(([ip, until]) => ({ ip, until }));
  }

  unblockAll() { this.blocked.clear(); this.strikes.clear(); }

  sweep() {
    const now = Date.now();
    for (const [ip, t] of this.blocked) if (t < now) this.blocked.delete(ip);
    for (const [ip, l] of this.strikes) if (!l.some(t => now - t < this.windowMs)) this.strikes.delete(ip);
  }
}

module.exports = { Guard, norm, isLoopback, isLan };
