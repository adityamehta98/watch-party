'use strict';

const dgram = require('dgram');
const crypto = require('crypto');

const MAGIC = 0x2112a442;
const M = { BINDING: 0x001, ALLOCATE: 0x003, REFRESH: 0x004, SEND: 0x006, DATA: 0x007, CREATE_PERMISSION: 0x008, CHANNEL_BIND: 0x009 };
const C = { REQUEST: 0, INDICATION: 1, SUCCESS: 2, ERROR: 3 };
const A = {
  MAPPED_ADDRESS: 0x0001, USERNAME: 0x0006, MESSAGE_INTEGRITY: 0x0008, ERROR_CODE: 0x0009,
  CHANNEL_NUMBER: 0x000c, LIFETIME: 0x000d, XOR_PEER_ADDRESS: 0x0012, DATA: 0x0013, REALM: 0x0014,
  NONCE: 0x0015, XOR_RELAYED_ADDRESS: 0x0016, REQUESTED_TRANSPORT: 0x0019, XOR_MAPPED_ADDRESS: 0x0020,
  SOFTWARE: 0x8022, FINGERPRINT: 0x8028,
};
const DEFAULT_LIFETIME = 600;
const PERMISSION_LIFETIME = 300;
const CHANNEL_LIFETIME = 600;

const typeOf = (method, cls) => (method & 0x000f) | ((method & 0x0070) << 1) | ((method & 0x0f80) << 2) | ((cls & 1) << 4) | ((cls & 2) << 7);
const methodOf = t => (t & 0x000f) | ((t & 0x00e0) >> 1) | ((t & 0x3e00) >> 2);
const classOf = t => ((t >> 4) & 1) | ((t >> 7) & 2);

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c; }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function parse(buf) {
  if (buf.length < 20 || (buf[0] & 0xc0) !== 0) return null;
  if (buf.readUInt32BE(4) !== MAGIC) return null;
  const type = buf.readUInt16BE(0);
  const length = buf.readUInt16BE(2);
  if (length + 20 > buf.length) return null;
  const attrs = [];
  let off = 20;
  while (off + 4 <= 20 + length) {
    const t = buf.readUInt16BE(off), l = buf.readUInt16BE(off + 2);
    attrs.push({ type: t, value: buf.subarray(off + 4, off + 4 + l), offset: off });
    off += 4 + l + ((4 - (l % 4)) % 4);
  }
  return { type, method: methodOf(type), cls: classOf(type), tid: buf.subarray(8, 20), attrs, raw: buf.subarray(0, 20 + length) };
}
const getAttr = (msg, t) => msg.attrs.find(a => a.type === t);

function xorAddr(value, tid) {
  // IPv4 only
  if (value.length < 8 || value[1] !== 0x01) return null;
  const port = value.readUInt16BE(2) ^ (MAGIC >>> 16);
  const ip = [0, 1, 2, 3].map(i => value[4 + i] ^ ((MAGIC >>> (24 - 8 * i)) & 0xff)).join('.');
  return { ip, port };
}
function encXorAddr(ip, port) {
  const b = Buffer.alloc(8);
  b[1] = 0x01;
  b.writeUInt16BE(port ^ (MAGIC >>> 16), 2);
  ip.split('.').map(Number).forEach((n, i) => { b[4 + i] = n ^ ((MAGIC >>> (24 - 8 * i)) & 0xff); });
  return b;
}

function build(method, cls, tid, attrs, key) {
  const parts = [];
  for (const [t, v] of attrs) {
    const h = Buffer.alloc(4); h.writeUInt16BE(t, 0); h.writeUInt16BE(v.length, 2);
    parts.push(h, v, Buffer.alloc((4 - (v.length % 4)) % 4));
  }
  let body = Buffer.concat(parts);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(typeOf(method, cls), 0);
  header.writeUInt32BE(MAGIC, 4);
  tid.copy(header, 8);
  if (key) {
    header.writeUInt16BE(body.length + 24, 2);
    const mac = crypto.createHmac('sha1', key).update(Buffer.concat([header, body])).digest();
    const h = Buffer.alloc(4); h.writeUInt16BE(A.MESSAGE_INTEGRITY, 0); h.writeUInt16BE(20, 2);
    body = Buffer.concat([body, h, mac]);
  }
  header.writeUInt16BE(body.length + 8, 2);
  const crc = (crc32(Buffer.concat([header, body])) ^ 0x5354554e) >>> 0;
  const fp = Buffer.alloc(8); fp.writeUInt16BE(A.FINGERPRINT, 0); fp.writeUInt16BE(4, 2); fp.writeUInt32BE(crc, 4);
  return Buffer.concat([header, body, fp]);
}

function checkIntegrity(msg, key) {
  const mi = getAttr(msg, A.MESSAGE_INTEGRITY);
  if (!mi) return false;
  const upto = Buffer.from(msg.raw.subarray(0, mi.offset));
  upto.writeUInt16BE(mi.offset - 20 + 24, 2);
  const mac = crypto.createHmac('sha1', key).update(upto).digest();
  return mi.value.length === 20 && crypto.timingSafeEqual(mac, mi.value);
}

function errorAttr(code, reason) {
  const r = Buffer.from(reason, 'utf8');
  const b = Buffer.alloc(4 + r.length);
  b[2] = Math.floor(code / 100); b[3] = code % 100; r.copy(b, 4);
  return [A.ERROR_CODE, b];
}

class TurnServer {
  constructor({ port, username, password, realm = 'watchparty', externalIp = null, localIps = [] }) {
    this.port = port;
    this.username = username;
    this.password = password;
    this.realm = realm;
    this.key = crypto.createHash('md5').update(`${username}:${realm}:${password}`).digest();
    this.nonce = crypto.randomBytes(12).toString('hex');
    this.externalIp = externalIp;
    this.localIps = new Set(['127.0.0.1', ...localIps]);
    this.allocations = new Map(); // "ip:port" of client -> allocation
    this.byRelayPort = new Map();  // relay port -> allocation
    this.stats = { allocations: 0, bytes: 0 };
    this.maxAllocations = 40;
    this.maxPerIp = 8;
    this.rate = new Map(); // ip -> { t, n } for unauthenticated replies
  }

  // at most ~30 unauthenticated replies per second per address (no amplification, no probing floods)
  allowReply(ip) {
    const now = Date.now();
    const r = this.rate.get(ip) || { t: now, n: 0 };
    if (now - r.t > 1000) { r.t = now; r.n = 0; }
    r.n++;
    this.rate.set(ip, r);
    if (this.rate.size > 5000) this.rate.clear();
    return r.n <= 30;
  }

  setExternalIp(ip) { this.externalIp = ip; }
  advertisedIp() { return this.externalIp || [...this.localIps].find(ip => ip !== '127.0.0.1') || '127.0.0.1'; }
  isOurIp(ip) { return ip === this.externalIp || this.localIps.has(ip); }

  start() {
    return new Promise((resolve, reject) => {
      const s = dgram.createSocket('udp4');
      this.sock = s;
      s.on('message', (buf, rinfo) => { try { this.onMessage(buf, rinfo); } catch (e) { /* ignore bad packets */ } });
      s.once('error', reject);
      s.bind(this.port, '0.0.0.0', () => { s.removeListener('error', reject); s.on('error', () => {}); resolve(); });
      this.sweeper = setInterval(() => this.sweep(), 30e3);
    });
  }

  stop() {
    clearInterval(this.sweeper);
    for (const a of this.allocations.values()) this.freeAllocation(a);
    try { this.sock.close(); } catch {}
  }

  reply(rinfo, buf) { this.sock.send(buf, rinfo.port, rinfo.address); }

  onMessage(buf, rinfo) {
    // ChannelData: first two bits 01
    if ((buf[0] & 0xc0) === 0x40 && buf.length >= 4) {
      const alloc = this.allocations.get(`${rinfo.address}:${rinfo.port}`);
      if (!alloc) return;
      const ch = buf.readUInt16BE(0), len = buf.readUInt16BE(2);
      const peer = alloc.channels.get(ch);
      if (!peer || peer.expires < Date.now()) return;
      this.relayOut(alloc, peer.ip, peer.port, buf.subarray(4, 4 + len));
      return;
    }
    const msg = parse(buf);
    if (!msg) return;
    const key = `${rinfo.address}:${rinfo.port}`;

    if (msg.method === M.BINDING && msg.cls === C.REQUEST) {
      if (!this.allowReply(rinfo.address)) return;
      return this.reply(rinfo, build(M.BINDING, C.SUCCESS, msg.tid, [[A.XOR_MAPPED_ADDRESS, encXorAddr(rinfo.address, rinfo.port)]]));
    }
    if (msg.method === M.SEND && msg.cls === C.INDICATION) {
      const alloc = this.allocations.get(key);
      const pa = getAttr(msg, A.XOR_PEER_ADDRESS), data = getAttr(msg, A.DATA);
      if (!alloc || !pa || !data) return;
      const peer = xorAddr(pa.value, msg.tid);
      if (peer && alloc.permissions.get(peer.ip) > Date.now()) this.relayOut(alloc, peer.ip, peer.port, data.value);
      return;
    }
    if (msg.cls !== C.REQUEST) return;

    // everything else needs the long-term credential
    const user = getAttr(msg, A.USERNAME);
    if (!user || !getAttr(msg, A.MESSAGE_INTEGRITY) || user.value.toString() !== this.username || !checkIntegrity(msg, this.key)) {
      if (!this.allowReply(rinfo.address)) return;
      return this.reply(rinfo, build(msg.method, C.ERROR, msg.tid, [errorAttr(401, 'Unauthorized'), [A.REALM, Buffer.from(this.realm)], [A.NONCE, Buffer.from(this.nonce)]]));
    }
    const nonce = getAttr(msg, A.NONCE);
    if (!nonce || nonce.value.toString() !== this.nonce) {
      return this.reply(rinfo, build(msg.method, C.ERROR, msg.tid, [errorAttr(438, 'Stale Nonce'), [A.REALM, Buffer.from(this.realm)], [A.NONCE, Buffer.from(this.nonce)]]));
    }
    const ok = attrs => this.reply(rinfo, build(msg.method, C.SUCCESS, msg.tid, attrs, this.key));
    const fail = (code, reason) => this.reply(rinfo, build(msg.method, C.ERROR, msg.tid, [errorAttr(code, reason)], this.key));
    const alloc = this.allocations.get(key);

    switch (msg.method) {
      case M.ALLOCATE: {
        if (alloc) {
          if (alloc.tid.equals(msg.tid)) return ok(alloc.successAttrs);
          return fail(437, 'Allocation Mismatch');
        }
        const mine = [...this.allocations.values()].filter(x => x.client.ip === rinfo.address).length;
        if (this.allocations.size >= this.maxAllocations || mine >= this.maxPerIp) return fail(486, 'Allocation Quota Reached');
        const rt = getAttr(msg, A.REQUESTED_TRANSPORT);
        if (!rt || rt.value[0] !== 17) return fail(442, 'Unsupported Transport Protocol');
        const lt = getAttr(msg, A.LIFETIME);
        const lifetime = Math.min(3600, lt ? lt.value.readUInt32BE(0) || DEFAULT_LIFETIME : DEFAULT_LIFETIME);
        this.createAllocation(key, rinfo, msg.tid, lifetime).then(a => {
          a.successAttrs = [
            [A.XOR_RELAYED_ADDRESS, encXorAddr(this.advertisedIp(), a.relayPort)],
            [A.XOR_MAPPED_ADDRESS, encXorAddr(rinfo.address, rinfo.port)],
            [A.LIFETIME, u32(lifetime)],
          ];
          ok(a.successAttrs);
        }).catch(() => fail(508, 'Insufficient Capacity'));
        return;
      }
      case M.REFRESH: {
        if (!alloc) return fail(437, 'Allocation Mismatch');
        const lt = getAttr(msg, A.LIFETIME);
        const lifetime = lt ? Math.min(3600, lt.value.readUInt32BE(0)) : DEFAULT_LIFETIME;
        if (lifetime === 0) { this.freeAllocation(alloc); return ok([[A.LIFETIME, u32(0)]]); }
        alloc.expires = Date.now() + lifetime * 1000;
        return ok([[A.LIFETIME, u32(lifetime)]]);
      }
      case M.CREATE_PERMISSION: {
        if (!alloc) return fail(437, 'Allocation Mismatch');
        const peers = msg.attrs.filter(a => a.type === A.XOR_PEER_ADDRESS).map(a => xorAddr(a.value, msg.tid)).filter(Boolean);
        if (!peers.length) return fail(400, 'Bad Request');
        for (const p of peers) alloc.permissions.set(p.ip, Date.now() + PERMISSION_LIFETIME * 1000);
        return ok([]);
      }
      case M.CHANNEL_BIND: {
        if (!alloc) return fail(437, 'Allocation Mismatch');
        const chA = getAttr(msg, A.CHANNEL_NUMBER), pa = getAttr(msg, A.XOR_PEER_ADDRESS);
        if (!chA || !pa) return fail(400, 'Bad Request');
        const ch = chA.value.readUInt16BE(0);
        const peer = xorAddr(pa.value, msg.tid);
        if (ch < 0x4000 || ch > 0x7ffe || !peer) return fail(400, 'Bad Request');
        const expires = Date.now() + CHANNEL_LIFETIME * 1000;
        alloc.channels.set(ch, { ...peer, expires });
        alloc.peerChannels.set(`${peer.ip}:${peer.port}`, ch);
        alloc.permissions.set(peer.ip, Date.now() + PERMISSION_LIFETIME * 1000);
        return ok([]);
      }
      default:
        return fail(400, 'Bad Request');
    }
  }

  createAllocation(key, rinfo, tid, lifetime) {
    return new Promise((resolve, reject) => {
      const relay = dgram.createSocket('udp4');
      relay.once('error', reject);
      relay.bind(0, '127.0.0.1', () => { // never reachable from outside; only used internally
        relay.removeListener('error', reject);
        relay.on('error', () => {});
        const a = {
          key, client: { ip: rinfo.address, port: rinfo.port }, tid: Buffer.from(tid), relay, relayPort: relay.address().port,
          expires: Date.now() + lifetime * 1000, permissions: new Map(), channels: new Map(), peerChannels: new Map(),
        };
        relay.on('message', (data, from) => { if (this.allowExternal) this.deliver(a, from.address, from.port, data); });
        this.allocations.set(key, a);
        this.byRelayPort.set(a.relayPort, a);
        this.stats.allocations++;
        resolve(a);
      });
    });
  }

  freeAllocation(a) {
    try { a.relay.close(); } catch {}
    this.allocations.delete(a.key);
    this.byRelayPort.delete(a.relayPort);
  }

  // data leaving an allocation towards a peer
  relayOut(alloc, ip, port, data) {
    this.stats.bytes += data.length;
    const target = this.isOurIp(ip) ? this.byRelayPort.get(port) : null;
    if (target) {
      // the peer is another relay on this PC: hand it over directly
      this.deliver(target, this.advertisedIp(), alloc.relayPort, data);
      return;
    }

    if (this.allowExternal) alloc.relay.send(data, port, ip);
  }

  // data arriving at an allocation from a peer, forwarded to its client
  deliver(alloc, ip, port, data) {
    if (!(alloc.permissions.get(ip) > Date.now())) return;
    const ch = alloc.peerChannels.get(`${ip}:${port}`);
    const c = ch && alloc.channels.get(ch);
    if (c && c.expires > Date.now()) {
      const pad = (4 - (data.length % 4)) % 4;
      const out = Buffer.alloc(4 + data.length + pad);
      out.writeUInt16BE(ch, 0); out.writeUInt16BE(data.length, 2); data.copy(out, 4);
      this.sock.send(out, alloc.client.port, alloc.client.ip);
      return;
    }
    const msg = build(M.DATA, C.INDICATION, crypto.randomBytes(12), [[A.XOR_PEER_ADDRESS, encXorAddr(ip, port)], [A.DATA, data]]);
    this.sock.send(msg, alloc.client.port, alloc.client.ip);
  }

  sweep() {
    const now = Date.now();
    for (const a of [...this.allocations.values()]) {
      if (a.expires < now) { this.freeAllocation(a); continue; }
      for (const [ip, t] of a.permissions) if (t < now) a.permissions.delete(ip);
      for (const [ch, c] of a.channels) if (c.expires < now) { a.channels.delete(ch); a.peerChannels.delete(`${c.ip}:${c.port}`); }
    }
  }
}

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; }

module.exports = { TurnServer };
