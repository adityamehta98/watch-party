'use strict';

const dgram = require('dgram');
const http = require('http');
const os = require('os');
const { EventEmitter } = require('events');

const SSDP_ADDR = process.env.WP_SSDP_ADDR || '239.255.255.250';
const SSDP_PORT = Number(process.env.WP_SSDP_PORT || 1900);
const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];

function localIPv4s() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push({ name, address: a.address, netmask: a.netmask });
    }
  }
  return out;
}

function isPrivate(ip) {
  const p = ip.split('.').map(Number);
  return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || p[0] === 127 || (p[0] === 169 && p[1] === 254) || p[0] === 0;
}

function discover(timeoutMs = 3500) {
  return new Promise(resolve => {
    const found = new Map(); // location -> { location, localAddress }
    const sockets = [];
    const ifaces = localIPv4s();
    const binds = ifaces.length ? ifaces.map(i => i.address) : ['0.0.0.0'];
    for (const addr of binds) {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sockets.push(s);
      s.on('error', () => {});
      s.on('message', msg => {
        const text = msg.toString();
        const m = text.match(/^location:\s*(.+)$/im);
        if (m) {
          const location = m[1].trim();
          if (!found.has(location)) found.set(location, { location, localAddress: addr === '0.0.0.0' ? null : addr });
        }
      });
      s.bind(0, addr, () => {
        for (const st of SEARCH_TARGETS) {
          const req = `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDR}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`;
          for (let i = 0; i < 2; i++) setTimeout(() => s.send(req, SSDP_PORT, SSDP_ADDR, () => {}), i * 400);
        }
      });
    }
    setTimeout(() => { for (const s of sockets) { try { s.close(); } catch {} } resolve([...found.values()]); }, timeoutMs);
  });
}

function httpRequest(url, { method = 'GET', headers = {}, body = null, timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, headers, timeout }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', d => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const tag = (xml, name) => { const m = xml.match(new RegExp(`<(?:\\w+:)?${name}>([^<]*)</(?:\\w+:)?${name}>`, 'i')); return m ? m[1].trim() : null; };

async function findService(dev) {
  const r = await httpRequest(dev.location);
  if (r.status !== 200) throw new Error(`device description HTTP ${r.status}`);
  const base = tag(r.body, 'URLBase') || dev.location;
  const services = r.body.split(/<service>/i).slice(1).map(chunk => ({
    type: tag(chunk, 'serviceType') || '', control: tag(chunk, 'controlURL') || '',
  }));
  const svc = services.find(s => /WANIPConnection/i.test(s.type)) || services.find(s => /WANPPPConnection/i.test(s.type));
  if (!svc) throw new Error('router does not offer port forwarding over UPnP');
  return { type: svc.type, control: new URL(svc.control, base).toString(), location: dev.location, localAddress: dev.localAddress };
}

async function soap(svc, action, args) {
  const body = `<?xml version="1.0"?>\r\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${svc.type}">` +
    Object.entries(args).map(([k, v]) => `<${k}>${v}</${k}>`).join('') + `</u:${action}></s:Body></s:Envelope>\r\n`;
  const r = await httpRequest(svc.control, {
    method: 'POST', body,
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', 'SOAPAction': `"${svc.type}#${action}"`, 'Content-Length': Buffer.byteLength(body) },
  });
  if (r.status !== 200) {
    const code = tag(r.body, 'errorCode');
    const desc = tag(r.body, 'errorDescription');
    const e = new Error(`${action} failed${code ? ` (${code}${desc ? ` ${desc}` : ''})` : ` (HTTP ${r.status})`}`);
    e.upnpCode = code ? Number(code) : null;
    throw e;
  }
  return r.body;
}

function pickLocalAddress(svc) {
  if (svc.localAddress) return svc.localAddress;
  const routerIp = new URL(svc.control).hostname;
  const ifs = localIPv4s();
  const same = ifs.find(i => i.address.split('.').slice(0, 3).join('.') === routerIp.split('.').slice(0, 3).join('.'));
  return (same || ifs[0] || {}).address;
}

class PortMapper extends EventEmitter {
  constructor() {
    super();
    this.state = { status: 'idle', externalIp: null, localIp: null, mappings: [], error: null };
    this.svc = null;
    this.renewTimer = null;
  }

  set(patch) { Object.assign(this.state, patch); this.emit('change', this.state); }

  // ports: [{ port, protocol: 'TCP'|'UDP' }]
  async start(ports) {
    this.ports = ports;
    this.set({ status: 'searching', error: null });
    try {
      const devices = await discover();
      if (!devices.length) { this.set({ status: 'no-upnp', error: 'No router answered. UPnP may be turned off in your router settings.' }); return this.state; }
      let lastErr = null;
      for (const d of devices) {
        try { this.svc = await findService(d); break; } catch (e) { lastErr = e; }
      }
      if (!this.svc) { this.set({ status: 'no-upnp', error: lastErr ? lastErr.message : 'No usable router found.' }); return this.state; }
      const localIp = pickLocalAddress(this.svc);
      let externalIp = null;
      try { externalIp = tag(await soap(this.svc, 'GetExternalIPAddress', {}), 'NewExternalIPAddress'); } catch { /* optional */ }
      this.set({ localIp, externalIp });
      const mappings = [];
      for (const p of ports) mappings.push(await this.map(p, localIp));
      this.set({ mappings });
      if (externalIp && isPrivate(externalIp) && !process.env.WP_TEST_PRIVATE_OK) {
        this.set({ status: 'cgnat', error: `Your router's internet address (${externalIp}) is itself private. Your provider (or a second router) is sharing one public address, so friends can't reach you directly.` });
      } else {
        this.set({ status: 'mapped' });
      }
      this.renewTimer = setInterval(() => this.renew().catch(() => {}), 20 * 60e3);
    } catch (e) {
      this.set({ status: 'failed', error: e.message });
    }
    return this.state;
  }

  async map({ port, protocol }, localIp) {
    const tryMap = async (ext, lease) => soap(this.svc, 'AddPortMapping', {
      NewRemoteHost: '', NewExternalPort: ext, NewProtocol: protocol, NewInternalPort: port,
      NewInternalClient: localIp, NewEnabled: 1, NewPortMappingDescription: `Watch Party ${protocol}`, NewLeaseDuration: lease,
    });
    let lease = 7200;
    for (let ext = port; ext < port + 10; ext++) {
      try {
        await tryMap(ext, lease);
        return { port, protocol, external: ext, lease };
      } catch (e) {
        if (e.upnpCode === 725) { lease = 0; ext--; continue; }       // router only allows permanent leases
        if (e.upnpCode === 718 || e.upnpCode === 729) continue;        // port taken by another device, try the next
        throw e;
      }
    }
    throw new Error(`Couldn't open a ${protocol} port near ${port}; they're all taken on the router.`);
  }

  async renew() {
    if (!this.svc || !this.state.localIp) return;
    for (const m of this.state.mappings) {
      if (m.lease) await soap(this.svc, 'AddPortMapping', {
        NewRemoteHost: '', NewExternalPort: m.external, NewProtocol: m.protocol, NewInternalPort: m.port,
        NewInternalClient: this.state.localIp, NewEnabled: 1, NewPortMappingDescription: `Watch Party ${m.protocol}`, NewLeaseDuration: m.lease,
      }).catch(() => {});
    }
  }

  async stop() {
    clearInterval(this.renewTimer);
    if (!this.svc) return;
    await Promise.all(this.state.mappings.map(m => soap(this.svc, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: m.external, NewProtocol: m.protocol }).catch(() => {})));
  }
}

module.exports = { PortMapper, discover, localIPv4s, isPrivate };
