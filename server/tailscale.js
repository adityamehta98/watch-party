'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const IS_WIN = process.platform === 'win32';

function findTailscale() {
  const exe = IS_WIN ? 'tailscale.exe' : 'tailscale';
  const candidates = [];
  if (IS_WIN) {
    candidates.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', exe));
    candidates.push(path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Tailscale', exe));
    // the Microsoft Store version puts a shortcut here
    if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', exe));
  } else {
    candidates.push('/usr/bin/tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale');
  }
  const notes = [`ProgramFiles=${process.env.ProgramFiles || '(unset)'}`];
  for (const c of candidates) { try { if (fs.statSync(c).isFile()) { notes.push(`found ${c}`); findTailscale.notes = notes; return c; } notes.push(`not a file: ${c}`); } catch (e) { notes.push(`${e.code || e.message}: ${c}`); } }
  let r = null;
  try { r = spawnSync(IS_WIN ? 'where' : 'which', [exe], { encoding: 'utf8', windowsHide: true }); } catch (e) { notes.push(`where failed: ${e.message}`); }
  if (r) notes.push(`where: status ${r.status} out "${(r.stdout || '').trim().slice(0, 200)}" err "${(r.stderr || '').trim().slice(0, 200)}"`);
  findTailscale.notes = notes;
  if (r && r.status === 0 && r.stdout) { const f = r.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean); if (f) return f; }
  return process.env.WP_TAILSCALE_BIN || null;
}

function run(bin, args, timeout = 20000, stopWhen = null) {
  return new Promise(done => {
    let out = '', err = '', finished = false;
    const resolve = r => { if (!finished) { finished = true; done(r); } };
    let p;
    try { p = spawn(bin, args, { windowsHide: true }); } catch (e) { return resolve({ code: -1, out: '', err: e.message }); }
    const t = setTimeout(() => { try { p.kill(); } catch {} resolve({ code: -2, out, err: err + '\n(timed out)' }); }, timeout);
    // give the rest of the message a moment to arrive, then stop waiting
    const check = () => { if (stopWhen && stopWhen.test(out + err) && !check.fired) { check.fired = true; setTimeout(() => { clearTimeout(t); try { p.kill(); } catch {} resolve({ code: 1, out, err }); }, 300); } };
    p.stdout.on('data', d => { out += d; check(); });
    p.stderr.on('data', d => { err += d; check(); });
    p.on('error', e => { clearTimeout(t); resolve({ code: -1, out, err: err + e.message }); });
    p.on('close', code => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

class Tailscale {
  constructor({ port, cacheDir, log = () => {} }) {
    this.port = port;
    this.cacheDir = cacheDir;
    this.log = log;
    this.bin = findTailscale();
    this.searchNotes = findTailscale.notes || [];
    try { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(path.join(cacheDir, 'tailscale-search.log'), `${new Date().toISOString()}\n${this.searchNotes.join('\n')}\nresult: ${this.bin || '(none)'}\n`); } catch { /* ignore */ }
    this.name = null;       // aditya-pc.tail1234.ts.net
    this.ip = null;
    this.online = false;
    this.cert = null;       // { key, cert, expires }
    this.certError = null;  // why there's no trusted certificate (e.g. HTTPS not enabled in the admin console)
    this.funnel = { on: false, url: null, error: null, busy: false };
    this.statusError = null; // why "tailscale status" gave us nothing
  }

  get present() { return !!this.bin; }

  async up() {
    if (!this.bin) return false;
    if (IS_WIN) {
      const gui = path.join(path.dirname(this.bin), 'tailscale-ipn.exe');
      try { if (fs.existsSync(gui)) spawn(gui, [], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref(); } catch { /* not there */ }
    }
    const login = /https:\/\/login\.tailscale\.com\/\S+/;
    let r = { code: 1, out: '', err: '' };
    // the app's background service may still be starting: try a few times
    for (let i = 0; i < 4; i++) {
      r = await run(this.bin, ['up'], 30000, login);
      if (r.code === 0 || login.test(r.out + r.err)) break;
      await new Promise(res => setTimeout(res, 3000));
    }
    const m = login.exec(r.out + r.err);
    this.loginUrl = m ? m[0] : null;
    if (r.code !== 0) this.upError = this.loginUrl ? 'Tailscale needs you to sign in.' : ((r.err || r.out || '').trim().split('\n')[0].slice(0, 200) || 'Tailscale didn\'t connect.');
    else this.upError = null;
    if (r.code === 0) this.log('  Tailscale connected.');
    else this.log(`  ! Tailscale: ${this.upError}`);
    return r.code === 0;
  }

  async down() {
    if (!this.bin) return;
    await run(this.bin, ['down'], 8000);
  }

  async refresh() {
    if (!this.bin) return;
    const r = await run(this.bin, ['status', '--json'], 8000);
    if (r.code !== 0) { this.online = false; this.statusError = (r.err || r.out || `exit code ${r.code}`).trim().split('\n')[0].slice(0, 200); return; }
    try {
      const st = JSON.parse(r.out);
      const self = st.Self || {};
      this.online = st.BackendState === 'Running' && !!self.Online;
      this.name = (self.DNSName || '').replace(/\.$/, '') || null;
      this.ip = (self.TailscaleIPs || []).find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || null;
      this.magicDns = !!(st.CurrentTailnet && st.CurrentTailnet.MagicDNSEnabled);
      this.statusError = !this.online ? `Tailscale reports "${st.BackendState || 'unknown'}"${self.Online === false ? ' (this PC is offline in Tailscale)' : ''}` : !this.name ? 'Tailscale gave no name for this PC (is MagicDNS turned on in the admin page, DNS section?)' : null;
    } catch (e) { this.online = false; this.statusError = 'Could not read the Tailscale status: ' + e.message; }
  }

  async ensureCert() {
    if (!this.bin || !this.name) return null;
    const certFile = path.join(this.cacheDir, 'ts-cert.pem');
    const keyFile = path.join(this.cacheDir, 'ts-key.pem');
    const info = this.certInfo(certFile);
    if (info && info.daysLeft > 20 && info.name === this.name) {
      this.cert = { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile), expires: info.expires };
      this.certError = null;
      return this.cert;
    }
    const r = await run(this.bin, ['cert', '--cert-file', certFile, '--key-file', keyFile, this.name], 90000);
    if (r.code !== 0) {
      const msg = (r.err || r.out || '').trim();
      this.certError = /not enabled|HTTPS|enable/i.test(msg) ? 'HTTPS certificates are not enabled for your Tailscale network yet.' : (msg.split('\n')[0] || 'Tailscale could not get a certificate.');
      this.log(`  ! Trusted certificate: ${this.certError}`);
      return null;
    }
    try {
      this.cert = { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile), expires: (this.certInfo(certFile) || {}).expires };
      this.certError = null;
      this.log(`  Trusted HTTPS certificate ready for ${this.name} (no browser warning).`);
      return this.cert;
    } catch (e) { this.certError = e.message; return null; }
  }

  certInfo(certFile) {
    try {
      const pem = fs.readFileSync(certFile, 'utf8');
      const { X509Certificate } = require('crypto');
      const x = new X509Certificate(pem);
      const expires = new Date(x.validTo).getTime();
      const cn = /CN=([^,\n]+)/.exec(x.subject);
      const san = x.subjectAltName || '';
      const name = (cn && cn[1]) || (/DNS:([^,\s]+)/.exec(san) || [])[1] || '';
      return { expires, daysLeft: (expires - Date.now()) / 86400000, name };
    } catch { return null; }
  }

  async setFunnel(on) {
    if (!this.bin) return false;
    this.funnel.busy = true;
    try {
      const target = `http://127.0.0.1:${this.port}`;
      const needsOk = /https:\/\/login\.tailscale\.com\/\S+/;
      const r = on ? await run(this.bin, ['funnel', '--bg', '--https=443', target], 30000, needsOk) : await run(this.bin, ['funnel', '--https=443', 'off'], 30000);
      if (on && needsOk.test(r.out + r.err)) r.code = r.code || 1; // it was waiting for you to allow it
      if (r.code !== 0) {
        const msg = ((r.err || '') + '\n' + (r.out || '')).trim();
        this.funnel.error = /not enabled/i.test(msg) ? 'Funnel (public links) isn\'t allowed for your Tailscale account yet.' : (msg.split('\n').filter(Boolean).slice(0, 2).join(' ') || 'Tailscale refused.');
        // Tailscale prints a link to enable Funnel for this account; keep it for the host
        const link = /(https:\/\/login\.tailscale\.com\S+)/.exec(msg);
        if (link) this.funnel.enableLink = link[1];
        if (on) this.funnel.on = false;
        return false;
      }
      this.funnel.error = null;
      this.funnel.enableLink = null;
      this.funnel.on = on;
      this.funnel.url = on && this.name ? `https://${this.name}` : null;
      return true;
    } finally { this.funnel.busy = false; }
  }

  async refreshFunnel() {
    if (!this.bin) return;
    const r = await run(this.bin, ['funnel', 'status', '--json'], 8000);
    if (r.code !== 0) return;
    try {
      const st = JSON.parse(r.out || '{}');
      const web = st.Web || {};
      const mine = Object.keys(web).find(k => k.endsWith(':443')) || null;
      const handlers = mine ? (web[mine].Handlers || {}) : {};
      const proxied = Object.values(handlers).some(h => h && /127\.0\.0\.1:|localhost:/.test(h.Proxy || '') && String(h.Proxy).endsWith(`:${this.port}`));
      const allowed = st.AllowFunnel || {};
      this.funnel.on = !!(mine && proxied && allowed[mine]);
      this.funnel.url = this.funnel.on && this.name ? `https://${this.name}` : null;
    } catch { /* leave as is */ }
  }
}

module.exports = { Tailscale };
