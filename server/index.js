'use strict';
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const tools = require('./tools');
const assets = require('./assets');
const { Library } = require('./library');
const { Room, randKey } = require('./room');
const { serveFile, authorizeHlsPlaylist } = require('./media');
const { Tunnel } = require('./tunnel');
const { PortMapper, localIPv4s, isPrivate } = require('./upnp');
const { TurnServer } = require('./turn');
const cert = require('./cert');
const crypto = require('crypto');
const { Guard, norm } = require('./guard');
const { Tailscale } = require('./tailscale');
const youtube = require('./youtube');
const anime = require('./anime');
const { cleanAppleExtensionUrl, migrateConfig } = require('./settings');
const pwa = require('./pwa');

const ROOT = tools.ROOT;
const CONFIG_PATH = path.join(ROOT, 'config.json');

// WatchParty.exe runs without a window, so what it prints also goes to cache\watchparty.log
// (started fresh each run; handy when something goes wrong).
(function logToFile() {
  try {
    const dir = path.join(ROOT, 'cache');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'watchparty.log');
    // a second copy that only reopens the page must not wipe the running one's log: start fresh only when big
    try { if (fs.statSync(file).size > 2 * 1024 * 1024) fs.writeFileSync(file, ''); } catch { /* new file */ }
    fs.appendFileSync(file, `\n----- Watch Party started ${new Date().toString()} (process ${process.pid})\n`);
    const strip = t => String(t).replace(/\x1b\[[0-9;]*m/g, '');
    for (const k of ['log', 'warn', 'error']) {
      const orig = console[k].bind(console);
      console[k] = (...a) => {
        try { orig(...a); } catch { /* no window */ }
        try {
          const line = a.map(x => (typeof x === 'string' ? x : x instanceof Error ? x.stack : JSON.stringify(x))).join(' ');
          if (!/[▀▄█]/.test(line)) fs.appendFileSync(file, strip(line) + '\n'); // skip the text QR code
        } catch { /* ignore */ }
      };
    }
  } catch { /* ignore */ }
})();

// A message box, for the few things you need to know when there's no window to print them in.
function notify(text) {
  if (process.platform !== 'win32' || !tools.IS_SEA) return;
  const msg = Buffer.from(String(text), 'utf8').toString('base64');
  const ps = `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${msg}')), 'Watch Party') | Out-Null`;
  try { spawn('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {}
}

// ---------------- config ----------------
const DEFAULT_CONFIG = {
  port: 8765,               // one port for everything: TCP for the page + movie, UDP for webcams
  bind: '0.0.0.0',
  folders: [],
  cacheDir: 'cache',
  linkMode: 'secure',       // "secure" = https link, webcams work, guests click past a one-time warning
                            // "plain"  = http link, no warning, no webcams
  upnp: true,               // ask the router to open the port automatically
  publicHost: '',           // your public IP / hostname if you forward the port yourself
  publicUrl: '',            // full override, e.g. your own domain
  tunnel: 'none',           // "cloudflare" only if you put cloudflared.exe in bin (last resort)
  uploadMbps: 0,
  maxChunkMB: 32,
  extraIceServers: [],      // optional extra STUN/TURN servers for webcams
  publicLink: false,        // Tailscale Funnel: a link that works for anyone (no Tailscale needed), TCP only
  webcamMode: 'auto',       // "relay": webcams only through this PC's own relay (nobody sees anyone's address)
                            // "direct": webcams connect browser to browser (works over the public link; people see each other's internet address)
                            // "auto": direct while the public link is on, relay otherwise
  cloudflareTurn: null,     // optional { keyId, token } from Cloudflare Realtime TURN: a relay for when direct webcams can't connect
  keepPrepared: false,      // false: prepared copies of movies are deleted when Watch Party stops (they're big)
  safariExtensionUrl: '',   // optional App Store or TestFlight link shown to Apple-device guests
  room: {},
  adminKey: '',             // secret in the host page address (generated)
  roomKey: '',              // secret in the invite link (generated; kept, so the link stays the same)
};

function loadConfig() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) {
    if (fs.existsSync(CONFIG_PATH)) console.warn('  config.json could not be read, using defaults:', e.message);
  }
  return { ...DEFAULT_CONFIG, ...migrateConfig(c) };
}
const config = loadConfig();
const cliOriginal = {};
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const out = { ...config, ...cliOriginal }; // command-line overrides are for this run only
    try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(out, null, 2)); } catch (e) { console.warn('  Could not save config.json:', e.message); }
  }, 200);
}

const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const override = (k, v) => { if (!(k in cliOriginal)) cliOriginal[k] = config[k]; config[k] = v; };
if (opt('--port')) override('port', Number(opt('--port')));
if (flag('--no-upnp')) override('upnp', false);
if (opt('--public-host')) override('publicHost', opt('--public-host'));
if (opt('--public-url')) override('publicUrl', opt('--public-url'));
if (opt('--bind')) override('bind', opt('--bind'));
if (flag('--tunnel')) override('tunnel', 'cloudflare');
if (opt('--folder')) config.folders = [...new Set([...(config.folders || []), path.resolve(opt('--folder'))])];
if (!config.adminKey) config.adminKey = randKey(20);
save();

// ---------------- parts ----------------
const bins = { ffmpeg: tools.findBin('ffmpeg'), ffprobe: tools.findBin('ffprobe'), cloudflared: config.tunnel === 'cloudflare' ? tools.findBin('cloudflared') : null };
const toolState = { ffmpeg: bins.ffmpeg, ffprobe: bins.ffprobe, encoders: null };
const library = new Library({ config, tools: toolState, save });
// YouTube search for guests with control (the host's page asks through /api/youtube/search)
const ytFetch = process.env.WP_TEST_YT_HTML ? async () => ({ ok: true, text: () => fs.promises.readFile(process.env.WP_TEST_YT_HTML, 'utf8') }) : undefined;
const ytSearchFn = q => youtube.search(q, ytFetch);
const room = new Room({ config, library, save, ytSearch: ytSearchFn, animeSearch: q => anime.search(q) });
anime.init(config.adminKey); // sign the anime proxy links with the admin key
const tunnel = config.tunnel === 'cloudflare' ? new Tunnel(bins.cloudflared, config.port) : null;
const mapper = new PortMapper();
const turnCreds = { username: 'watchparty', password: randKey(18) };
const turn = new TurnServer({ port: config.port, ...turnCreds, localIps: localIPv4s().map(i => i.address) });
const guard = new Guard({ log: m => console.log(m) });
const ts = new Tailscale({ port: config.port, cacheDir: path.join(ROOT, config.cacheDir || 'cache'), log: m => console.log(m) });
const healthToken = randKey(24);
let turnOk = false;
let reachable = 'unknown';

library.on('update', () => {
  room.refreshLibraryMovie();
  room.broadcast({ type: 'library-changed' });
});
library.on('progress', p => room.broadcast({ type: 'job', ...p }));

const tcpMapping = () => mapper.state.mappings.find(m => m.protocol === 'TCP');
const udpMapping = () => mapper.state.mappings.find(m => m.protocol === 'UDP');

function publicHost() {
  if (config.publicHost) return config.publicHost.trim();
  const ip = mapper.state.externalIp;
  if (ip && (!isPrivate(ip) || process.env.WP_TEST_PRIVATE_OK) && mapper.state.status === 'mapped') return ip;
  return null;
}
// Tailscale: a private network app. If it's running on this PC, friends who you've shared this PC with
// can reach it at its Tailscale address, even when your internet provider blocks incoming connections.
function tailscaleIp() {
  if (process.env.WP_TEST_TS_IP) return process.env.WP_TEST_TS_IP; // tests only
  // Only while Tailscale is really connected. Other things on a PC (virtual machines, VPNs, some
  // internet providers) use 100.64-127.x addresses too, and a link to those reaches nobody.
  if (ts.present && !ts.online) return null;
  const ifs = localIPv4s();
  const own = ts.ip && ifs.find(i => i.address === ts.ip);
  const named = ifs.find(i => /tailscale/i.test(i.name));
  const range = ts.online && ifs.find(i => { const p = i.address.split('.').map(Number); return p[0] === 100 && p[1] >= 64 && p[1] <= 127; });
  return (own || named || range || {}).address || (ts.online && ts.ip) || null;
}
// With a trusted certificate the link uses the PC's Tailscale name (no browser warning); otherwise its address.
const tailscaleBase = () => { const ip = tailscaleIp(); if (!ip) return null; return ts.cert && ts.name ? `https://${ts.name}:${config.port}` : `https://${ip}:${config.port}`; };
const funnelBase = () => (config.publicLink && ts.funnel.on && ts.funnel.url) ? ts.funnel.url : null;

function publicBase() {
  if (config.publicUrl) return config.publicUrl.replace(/\/+$/, '');
  if (funnelBase()) return funnelBase();
  if (tunnel && tunnel.url) return tunnel.url;
  const h = publicHost();
  if (!h) return config.connectVia !== 'internet' ? tailscaleBase() : null;
  if (config.connectVia === 'tailscale' && tailscaleBase()) return tailscaleBase();
  const port = (tcpMapping() && !config.publicHost) ? tcpMapping().external : config.port;
  return `${config.linkMode === 'plain' ? 'http' : 'https'}://${h}:${port}`;
}
const joinUrl = () => { const b = publicBase(); return b ? `${b}/join/${room.roomKey}` : null; };
// 127.0.0.1 rather than "localhost": on some Windows PCs "localhost" goes to the IPv6 address first,
// and if another program sits there the browser shows "localhost didn't send any data".
const localBase = () => `http://127.0.0.1:${config.port}`;

function lanJoinUrl() {
  const ip = mapper.state.localIp || (localIPv4s()[0] || {}).address;
  return ip ? `${config.linkMode === 'plain' ? 'http' : 'https'}://${ip}:${config.port}/join/${room.roomKey}` : null;
}

function isLocalHostHeader(host) {
  const h = String(host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (process.env.WP_TEST_REMOTE_HOST && h === process.env.WP_TEST_REMOTE_HOST) return false; // tests only
  return h === 'localhost' || h.startsWith('127.') || h === '::1';
}

// Webcams. Normally they go through this PC's own relay (UDP on the same port), so nobody ever sees
// anyone else's internet address. The public link (Tailscale Funnel) only carries web traffic, not
// that relay, so while it's on, webcams connect browser to browser instead, found with the help of
// public "STUN" servers (they only tell each browser its own address). If two networks are too strict
// for that, an optional Cloudflare TURN key adds a relay that always works.
const PUBLIC_STUN = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
const directCams = () => config.webcamMode === 'direct' || (config.webcamMode !== 'relay' && !!funnelBase());
let cfTurn = { servers: null, at: 0, error: null };
async function refreshCloudflareTurn() {
  const c = config.cloudflareTurn;
  if (!c || !c.keyId || !c.token) { cfTurn = { servers: null, at: 0, error: null }; return; }
  try {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(c.keyId)}/credentials/generate-ice-servers`, {
      method: 'POST', headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 86400 }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error(`Cloudflare said ${r.status}${r.status === 401 || r.status === 403 ? ' (check the key ID and token)' : ''}`);
    const j = await r.json();
    const list = [].concat(j.iceServers || []).map(sv => ({ ...sv, urls: [].concat(sv.urls || []).filter(u => !/:53(\?|$)/.test(u)) })).filter(sv => sv.urls.length);
    cfTurn = { servers: list, at: Date.now(), error: null };
  } catch (e) { cfTurn = { servers: null, at: Date.now(), error: e.message }; }
}
setInterval(() => { if (config.cloudflareTurn) refreshCloudflareTurn().then(() => room.updateIce && room.updateIce()); }, 12 * 3600 * 1000);
function iceServersFor(reqInfo) {
  const out = [];
  const direct = directCams();
  if (turnOk && !reqInfo.funnel) {
    const local = isLocalHostHeader(reqInfo.host);
    const host = local ? '127.0.0.1' : String(reqInfo.host || '').replace(/:\d+$/, '');
    const port = local || !udpMapping() || config.publicHost ? config.port : udpMapping().external;
    if (host && net.isIP(host.replace(/^\[|\]$/g, '')) !== 6) out.push({ urls: [`turn:${host}:${port}?transport=udp`], username: turnCreds.username, credential: turnCreds.password });
  }
  if (direct) out.push(...PUBLIC_STUN);
  if (direct && cfTurn.servers) out.push(...cfTurn.servers);
  return out.concat(config.extraIceServers || []);
}

async function info() {
  if (ts.present && Date.now() - (info.lastTs || 0) > 5000) { info.lastTs = Date.now(); await ts.refresh().catch(() => {}); }
  const url = joinUrl();
  let qr = null;
  if (url) qr = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
  return {
    joinUrl: url, lanJoinUrl: lanJoinUrl(), qr,
    linkMode: config.linkMode,
    network: {
      ...mapper.state, upnpEnabled: config.upnp, reachable, publicHost: config.publicHost, port: config.port,
      tailscale: (tailscaleIp() || ts.present) ? { ip: tailscaleIp(), name: ts.name, url: tailscaleIp() ? `${tailscaleBase()}/join/${room.roomKey}` : null, inUse: !!tailscaleIp() && (joinUrl() || '').startsWith(tailscaleBase()),
        trusted: !!ts.cert, certError: ts.certError, app: ts.present, appPath: ts.bin, online: ts.online, statusError: ts.upError || ts.statusError, loginUrl: ts.loginUrl || null, searchNotes: ts.searchNotes,
        funnel: { wanted: !!config.publicLink, on: !!ts.funnel.on, url: ts.funnel.url, error: ts.funnel.error, enableLink: ts.funnel.enableLink || null, busy: !!ts.funnel.busy, inUse: !!funnelBase() } } : null,
      tcpExternal: tcpMapping() ? tcpMapping().external : null, udpExternal: udpMapping() ? udpMapping().external : null,
      webcamRelay: turnOk,
      webcams: { mode: config.webcamMode || 'auto', direct: directCams(), cloudflare: config.cloudflareTurn ? { keyId: config.cloudflareTurn.keyId, ok: !!cfTurn.servers, error: cfTurn.error } : null },
    },
    tunnel: tunnel ? { status: tunnel.status, url: tunnel.url, lastLog: tunnel.lastLog } : null,
    tools: { ffmpeg: !!bins.ffmpeg, ffprobe: !!bins.ffprobe },
    encoders: toolState.encoders,
    encoderLabel: toolState.encoders ? tools.encoderLabel(toolState.encoders.hevc || toolState.encoders.h264) : null,
    uploadMbps: config.uploadMbps || 0,
    settings: room.publicSettings(true),
    blocked: guard.list(),
    extensionDir: fs.existsSync(path.join(ROOT, 'extension', 'manifest.json')) ? path.join(ROOT, 'extension') : null,
    updatePending: updatePending(),
  };
}
function updatePending() { return fs.existsSync(path.join(ROOT, '_update', 'WatchParty.part00')); }

// Try to open our own public link from here. Many routers support this "hairpin" trick; if it
// works we know the port is open. If it fails, it may still work for friends outside.
async function checkReachable() {
  const base = publicBase();
  if (!base || tunnel) { reachable = 'unknown'; return; }
  reachable = 'checking';
  room.broadcastHosts({ type: 'network' });
  const ok = await new Promise(resolve => {
    const lib = base.startsWith('https') ? https : http;
    const req = lib.get(`${base}/healthz?t=${healthToken}`, { rejectUnauthorized: false, timeout: 5000 }, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
  reachable = ok ? 'yes' : 'unknown';
  room.broadcastHosts({ type: 'network' });
}

async function startTailscale() {
  if (!ts.present) return;
  await ts.refresh();
  if (!ts.online && !startTailscale.tried) {
    startTailscale.tried = true;
    await ts.up(); // connect it now; it's disconnected again when Watch Party stops
    await ts.refresh();
  }
  if (!ts.online) {
    // Not connected yet (Tailscale closed, or signed out): look again now and then, and carry on by
    // itself the moment it's connected (the public link switches on without restarting Watch Party).
    const again = setInterval(async () => {
      await ts.refresh().catch(() => {});
      if (!ts.online) return;
      clearInterval(again);
      console.log('  Tailscale is connected now.');
      room.broadcastHosts({ type: 'network' });
      startTailscale().catch(e => console.log('  ! Tailscale:', e.message)).finally(() => printInvite());
    }, 15000);
    return;
  }
  if (await ts.ensureCert()) useTrustedCert();
  await ts.refreshFunnel();
  if (!config.publicLink && ts.funnel.on) await ts.setFunnel(false); // switched off in the Room tab earlier
  room.broadcastHosts({ type: 'network' });
  printInvite();
  if (config.publicLink && !ts.funnel.on) await ts.setFunnel(true);
  room.broadcastHosts({ type: 'network' });
  room.updateIce();
  printInvite();
  // Waiting for you to allow Funnel in the browser: keep trying quietly, and switch the link over
  // by itself the moment it works (no need to flip the switch off and on).
  setInterval(async () => {
    if (!config.publicLink || ts.funnel.on || ts.funnel.busy || !ts.funnel.error) return;
    if (await ts.setFunnel(true)) { console.log('  Public link is on.'); room.broadcastHosts({ type: 'network' }); room.updateIce(); printInvite(); }
  }, 15000);
  // certificates last 90 days; check now and then
  setInterval(async () => { await ts.refresh(); if (await ts.ensureCert()) useTrustedCert(); }, 6 * 3600 * 1000);
}
async function startNetwork() {
  if (config.cloudflareTurn) refreshCloudflareTurn().then(() => room.updateIce()).catch(() => {});
  // Tailscale runs alongside the router setup, so neither holds up the invite link
  startTailscale().catch(e => console.log('  ! Tailscale:', e.message)).finally(() => printInvite());
  printInvite();
  if (!config.upnp) { mapper.set({ status: 'off' }); printInvite(); return; }
  await mapper.start([{ port: config.port, protocol: 'TCP' }, { port: config.port, protocol: 'UDP' }]);
  const ext = mapper.state.externalIp;
  if (ext && (!isPrivate(ext) || process.env.WP_TEST_PRIVATE_OK)) turn.setExternalIp(ext);
  room.broadcastHosts({ type: 'network' });
  await checkReachable();
  printInvite();
}
mapper.on('change', () => room.broadcastHosts({ type: 'network' }));

// ---------------- http ----------------
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', d => { data += d; if (data.length > 1e6) { reject(new Error('too big')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function serveStatic(req, res, rel, extraHeaders = {}) {
  const a = assets.get(rel);
  if (!a) return notFound(req, res, 'unknown file');
  res.writeHead(200, { 'Content-Type': a.type, 'Cache-Control': rel.endsWith('.html') ? 'no-store' : 'no-cache', ...extraHeaders });
  res.end(a.body);
}

// A request counts as "from this PC" only if it arrives on the loopback address with a localhost Host
// header. (Checking the Host header also defeats "DNS rebinding" tricks from malicious websites.)
const isLocal = req => /^(::1|127\.|::ffff:127\.)/.test(req.socket.remoteAddress || '') && isLocalHostHeader(req.headers.host) &&
  !req.headers['x-forwarded-for'] && !req.headers['cf-connecting-ip'];
// Through the optional Cloudflare tunnel, Cloudflare handles the encryption and tells us the real address.
const viaTunnel = req => !!(tunnel && req.headers['cf-connecting-ip'] && /^(::1|127\.|::ffff:127\.)/.test(req.socket.remoteAddress || ''));
// Through Tailscale Funnel (the public link), Tailscale handles the encryption on this PC and hands us
// plain requests on the loopback address with the visitor's real address in X-Forwarded-For.
const viaFunnel = req => !!(ts.funnel.on && req.headers['x-forwarded-for'] && (/^https$/i.test(String(req.headers['x-forwarded-proto'] || '')) || req.headers['tailscale-funnel-request'])
  && /^(::1|127\.|::ffff:127\.)/.test(req.socket.remoteAddress || ''));
const clientIp = req => viaTunnel(req) ? norm(String(req.headers['cf-connecting-ip'])) : viaFunnel(req) ? norm(String(req.headers['x-forwarded-for']).split(',')[0].trim()) : norm(req.socket.remoteAddress);
const isSecure = req => !!req.socket.encrypted || viaTunnel(req) || viaFunnel(req);
const effectiveHost = req => String((viaFunnel(req) && req.headers['x-forwarded-host']) || req.headers.host || '');

// Answer anything unexpected with a bare 404 so the app doesn't reveal itself, and count it.
const PUBLIC_ASSETS = new Set(['/favicon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/apple-touch-icon-precomposed.png', '/favicon.ico']);
function notFound(req, res, why) {
  // someone already in the room (same address) is a guest whose phone asked for something stale, not a guesser
  if (!isLocal(req) && !room.hasAdmittedIp(clientIp(req))) guard.strike(clientIp(req), why);
  res.writeHead(404, { 'Content-Type': 'text/plain', 'Connection': 'close' });
  res.end('Not found');
}

function cookieKey(req) {
  // wp_kt is the same key, stored the way a page inside the extension's window can use it
  const m = /(?:^|;\s*)wp_kt?=([A-Za-z0-9]+)/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}

// "Watch here" mode: the Watch Party Sync extension shows this page inside its own window, next to
// Netflix / Prime Video / ... Only a browser extension may frame the page, never another website.
function isTheaterPage(req) { return /[?&]theater=1(&|$)/.test(req.url || ''); }
function securityHeaders(req, res) {
  const host = effectiveHost(req).replace(/[^A-Za-z0-9.:\[\]-]/g, '');
  const theater = isTheaterPage(req);
  // YouTube is the only outside site the page may load, and only when you show a YouTube video.
  // megaplay.buzz is framed for extension-free anime playback; s4.anilist.co serves search posters.
  res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' https://www.youtube.com https://s.ytimg.com; worker-src 'self' blob:; frame-src https://www.youtube.com https://www.youtube-nocookie.com https://megaplay.buzz; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://i.ytimg.com https://s4.anilist.co; media-src 'self' blob:; connect-src 'self' wss://${host} ws://${host}; frame-ancestors ${theater ? 'chrome-extension:' : "'none'"}; base-uri 'none'; form-action 'self'; object-src 'none'`);
  if (!theater) res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=(), display-capture=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
}

const safeEq = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function api(req, res, p) {
  // The host controls work only from this PC, never over the internet.
  const key = req.headers['x-admin-key'];
  if (!isLocal(req) || !safeEq(key, config.adminKey)) return notFound(req, res, 'api');
  if (req.method === 'POST' && !/^application\/json/.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'json only' });
  const body = req.method === 'POST' ? await readBody(req) : {};
  let m;
  if (p === '/api/info') return sendJson(res, 200, await info());
  if (p === '/api/youtube/search') {
    const q = new URL(req.url, 'http://x').searchParams.get('q') || '';
    try {
      return sendJson(res, 200, { results: await ytSearchFn(q) });
    } catch (e) { return sendJson(res, 502, { error: `Couldn't search YouTube right now (${e.message}). You can still paste a video link.` }); }
  }
  if (p === '/api/anime/search') {
    const q = new URL(req.url, 'http://x').searchParams.get('q') || '';
    try { return sendJson(res, 200, { results: await anime.search(q) }); }
    catch (e) { return sendJson(res, 502, { error: `Couldn't search anime right now (${e.message}).` }); }
  }
  if (p === '/api/library') return sendJson(res, 200, library.list());
  if (p === '/api/library/folders' && req.method === 'POST') return sendJson(res, 200, await library.setFolders(body.folders || []));
  if (p === '/api/library/rescan' && req.method === 'POST') { library.scan(); return sendJson(res, 200, { ok: true }); }
  if ((m = p.match(/^\/api\/probe\/(\w+)$/))) { const i = library.items.get(m[1]); if (i) { i.info = null; i.probeError = null; } await library.probe(m[1]); return sendJson(res, 200, { ok: true }); }
  if ((m = p.match(/^\/api\/prepare\/(\w+)$/)) && req.method === 'POST') {
    try { library.prepare(m[1], body); return sendJson(res, 200, { ok: true }); } catch (e) { return sendJson(res, 400, { error: e.message }); }
  }
  if ((m = p.match(/^\/api\/cancel\/(\w+)$/)) && req.method === 'POST') { library.cancel(m[1]); return sendJson(res, 200, { ok: true }); }
  if ((m = p.match(/^\/api\/prepared\/(\w+)$/)) && req.method === 'DELETE') {
    if (room.movie && room.movie.id === m[1]) return sendJson(res, 400, { error: 'That movie is loaded in the room right now.' });
    library.removePrepared(m[1]); return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/settings' && req.method === 'POST') {
    if ('uploadMbps' in body) config.uploadMbps = Math.max(0, Number(body.uploadMbps) || 0);
    if ('webcamMode' in body && ['auto', 'relay', 'direct'].includes(body.webcamMode)) { config.webcamMode = body.webcamMode; save(); room.updateIce(); }
    if ('cloudflareTurn' in body) {
      const c = body.cloudflareTurn || {};
      const keyId = String(c.keyId || '').trim().replace(/[^A-Za-z0-9_-]/g, ''), token = String(c.token || '').trim().replace(/\s/g, '');
      config.cloudflareTurn = keyId && token ? { keyId, token } : null;
      save();
      await refreshCloudflareTurn();
      room.updateIce();
    }
    if ('publicLink' in body) {
      config.publicLink = !!body.publicLink;
      save();
      await ts.refresh();
      await ts.setFunnel(config.publicLink);
      room.broadcastHosts({ type: 'network' });
      room.updateIce();
      printInvite();
    }
    if ('publicHost' in body) { config.publicHost = String(body.publicHost || '').trim().replace(/^https?:\/\//, '').replace(/[:/].*$/, '').replace(/[^A-Za-z0-9.-]/g, ''); delete cliOriginal.publicHost; }
    if ('safariExtensionUrl' in body) {
      const raw = String(body.safariExtensionUrl || '').trim();
      const clean = cleanAppleExtensionUrl(raw);
      if (raw && !clean) return sendJson(res, 400, { error: 'Use an apps.apple.com or testflight.apple.com HTTPS link.' });
      config.safariExtensionUrl = clean;
      room.broadcastSettings();
    }
    save();
    if ('publicHost' in body) checkReachable();
    return sendJson(res, 200, await info());
  }
  if (p === '/api/unblock' && req.method === 'POST') { guard.unblockAll(); return sendJson(res, 200, await info()); }
  if (p === '/api/network/retry' && req.method === 'POST') { await mapper.stop(); mapper.state.mappings = []; startNetwork(); return sendJson(res, 200, { ok: true }); }
  if (p === '/api/network/lookup-ip' && req.method === 'POST') {
    // Only runs when you click "Look up" in the app. Asks a public "what is my IP" service.
    try {
      const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(6000) });
      const j = await r.json();
      return sendJson(res, 200, { ip: String(j.ip || '').replace(/[^0-9a-fA-F.:]/g, '') });
    } catch (e) { return sendJson(res, 502, { error: 'Could not look it up. Check your router\'s status page or search "what is my IP".' }); }
  }
  return sendJson(res, 404, { error: 'not found' });
}

function media(req, res, p, u) {
  const role = room.roleForKey(u.searchParams.get('k'), isLocal(req));
  if (!role) return notFound(req, res, 'media key');
  const m = p.match(/^\/media\/(\w+)\/(video|sub\/(\w+)\.vtt|hls\/(index\.m3u8|init\.mp4|seg-\d{5}\.m4s))$/);
  if (!m) return notFound(req, res, 'media path');
  // From here on the request carries the real room key: a miss (an old movie, a file that was
  // cleaned up, a player prefetching after a switch) is a plain 404 and never counts as a guess.
  const missing = () => { res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); return res.end('Not found'); };
  const id = m[1];
  if (role !== 'host' && (!room.movie || room.movie.id !== id)) return missing();
  const clientId = u.searchParams.get('c');
  if (m[2] === 'video') {
    const pl = (room.movie && room.movie.id === id) ? room.movie : library.playable(id);
    if (!pl?.file) return missing();
    return serveFile(req, res, pl.file, { onBytes: n => room.addBytes(clientId, n), maxChunk: config.maxChunkMB > 0 ? config.maxChunkMB * 1024 * 1024 : 0 });
  }
  if (m[4]) {
    const file = library.hlsFile(id, m[4]);
    if (!file) return missing();
    if (m[4] !== 'index.m3u8') return serveFile(req, res, file, { onBytes: n => room.addBytes(clientId, n) });
    try {
      const auth = new URLSearchParams({ k: u.searchParams.get('k') || '' });
      if (clientId) auth.set('c', clientId);
      const body = authorizeHlsPlaylist(fs.readFileSync(file, 'utf8'), auth.toString());
      // Growing EVENT playlists must be re-fetched often. 'no-cache' tells Safari to
      // revalidate on every request; 'no-store' can confuse iOS's HLS stack. Final (complete)
      // playlists are small and change rarely, so the same policy works for both.
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-cache, must-revalidate', 'X-Content-Type-Options': 'nosniff' });
      return req.method === 'HEAD' ? res.end() : res.end(body);
    } catch { return missing(); }
  }
  const file = library.subFile(id, m[3]);
  if (!file) return missing();
  try {
    const text = library.readSub(file);
    res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(text);
  } catch { res.writeHead(500); res.end(); }
}

// Reverse-proxy for native anime playback: the HLS playlist, its segments/keys and subtitle tracks
// are fetched from the resolved upstream (with the Referer it expects) and streamed back from this
// origin, so the browser plays raw video with no third-party iframe and no ads. Links are signed
// (so a guest can't make us fetch an arbitrary URL) and still require the room key, exactly like
// /media. A miss is a plain 404 and never counts as a wrong key guess.
async function animeProxy(req, res, p, u) {
  const role = room.roleForKey(u.searchParams.get('k'), isLocal(req));
  if (!role) return notFound(req, res, 'anime key');
  const target = anime.parseProxyPath(p);
  const fail = (code = 404) => { res.writeHead(code, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); return res.end(code === 404 ? 'Not found' : 'Upstream error'); };
  if (!target) return fail(404);
  // Only a current-movie request is served to guests; the host (local) may prefetch freely.
  if (role !== 'host' && (!room.movie || room.movie.kind !== 'anime')) return fail(404);
  try {
    if (target.kind === 'm3u8') {
      const r = await anime.fetchUpstream(target.url, target.referer);
      if (!r.ok) return fail(r.status === 404 ? 404 : 502);
      const text = await r.text();
      const auth = new URLSearchParams({ k: u.searchParams.get('k') || '' });
      const c = u.searchParams.get('c'); if (c) auth.set('c', c);
      const body = anime.rewriteM3u8(text, r.url || target.url, target.referer, auth.toString());
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-cache, must-revalidate', 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*' });
      return req.method === 'HEAD' ? res.end() : res.end(body);
    }
    if (target.kind === 'sub') {
      const r = await anime.fetchUpstream(target.url, target.referer);
      if (!r.ok) return fail(r.status === 404 ? 404 : 502);
      const body = anime.toVtt(await r.text());
      res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*' });
      return req.method === 'HEAD' ? res.end() : res.end(body);
    }
    // a media segment, encryption key or init segment: stream the bytes, relaying Range
    const extra = req.headers.range ? { Range: req.headers.range } : {};
    const r = await anime.fetchUpstream(target.url, target.referer, extra);
    if (!(r.ok || r.status === 206)) return fail(r.status === 404 ? 404 : 502);
    const h = { 'Cache-Control': 'public, max-age=30', 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes' };
    const ct = r.headers.get('content-type'); if (ct) h['Content-Type'] = ct;
    const cl = r.headers.get('content-length'); if (cl) h['Content-Length'] = cl;
    const cr = r.headers.get('content-range'); if (cr) h['Content-Range'] = cr;
    res.writeHead(r.status === 206 ? 206 : 200, h);
    if (req.method === 'HEAD' || !r.body) return res.end();
    const stream = anime.Readable.fromWeb(r.body);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    return stream.pipe(res);
  } catch { return fail(502); }
}

async function handler(req, res) {
  let u, p;
  try { u = new URL(req.url, 'http://x'); p = decodeURIComponent(u.pathname); } catch { return notFound(req, res, 'bad url'); }
  if ((viaTunnel(req) || viaFunnel(req)) && guard.isBlocked(clientIp(req))) { req.socket.destroy(); return; }
  securityHeaders(req, res);
  const local = isLocal(req);
  const secure = isSecure(req);
  try {
    if (!['GET', 'HEAD', 'POST', 'DELETE'].includes(req.method)) return notFound(req, res, 'method');
    // Guests always use the encrypted https link (unless the host chose "plain" in config.json).
    if (!local && !secure && config.linkMode !== 'plain') {
      if (/^\/join\/[A-Za-z0-9]+\/?$/.test(p)) {
        const host = effectiveHost(req).replace(/[^A-Za-z0-9.:\[\]-]/g, '');
        res.writeHead(301, { Location: `https://${host}${p}` });
        return res.end();
      }
      return notFound(req, res, 'plain http');
    }
    if (p === '/') {
      if (local) { res.writeHead(302, { Location: `/host/${config.adminKey}` }); return res.end(); }
      return notFound(req, res, 'root');
    }
    let m;
    if ((m = p.match(/^\/host\/([A-Za-z0-9]+)\/?$/))) {
      if (!local || !safeEq(m[1], config.adminKey)) return notFound(req, res, 'host page');
      return serveStatic(req, res, 'index.html');
    }
    if ((m = p.match(/^\/join\/([A-Za-z0-9]+)\/?$/))) {
      if (!safeEq(m[1], room.roomKey)) return notFound(req, res, 'join key');
      // cookie lets the page load its own files; it's useless without the current room key
      const cookies = [`wp_k=${room.roomKey}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`];
      if (isTheaterPage(req) && secure) cookies.push(`wp_kt=${room.roomKey}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned`);
      return serveStatic(req, res, 'index.html', { 'Set-Cookie': cookies });
    }
    if (p.startsWith('/api/')) return await api(req, res, p);
    if (p.startsWith('/media/')) return media(req, res, p, u);
    if (p.startsWith('/anime/')) return animeProxy(req, res, p, u);
    if (p === '/healthz') return u.searchParams.get('t') === healthToken ? sendJson(res, 200, { ok: true }) : notFound(req, res, 'health');
    // Icons are public and harmless. Browsers and iOS fetch them (and the install manifest) without
    // cookies, so they must never count as a wrong guess: ten of those used to lock a guest out.
    if (PUBLIC_ASSETS.has(p)) {
      const rel = p.startsWith('/apple-touch-icon') ? 'icon-192.png' : p.slice(1);
      if (!assets.get(rel)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
      return serveStatic(req, res, rel);
    }
    const invited = local || safeEq(cookieKey(req), room.roomKey);
    if (!invited && p === '/manifest.webmanifest') { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    // page files (css/js): only for this PC or someone who opened a valid invite link
    if (!invited) return notFound(req, res, 'asset without invite');
    if (p === '/manifest.webmanifest') {
      const startUrl = local ? `/host/${config.adminKey}` : `/join/${room.roomKey}`;
      res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'private, no-store', 'Vary': 'Cookie' });
      return res.end(JSON.stringify(pwa.manifest(startUrl)));
    }
    return serveStatic(req, res, p.slice(1));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: 'server error' });
    else res.destroy();
  }
}

// One port answers both plain http:// (this PC only) and https:// (guests). We peek at the first byte.
const tlsFile = path.join(ROOT, 'cache', 'https-cert.json');
fs.mkdirSync(path.dirname(tlsFile), { recursive: true });
const tlsCert = cert.loadOrCreate(tlsFile, []);
const httpServer = http.createServer({ maxHeaderSize: 16384 }, handler);
const tls = require('tls');
let trustedCtx = null; // the Let's Encrypt certificate for this PC's Tailscale name, when we have one
const httpsServer = https.createServer({
  key: tlsCert.key, cert: tlsCert.cert, minVersion: 'TLSv1.2', maxHeaderSize: 16384,
  SNICallback: (name, cb) => cb(null, trustedCtx && ts.name && name.toLowerCase() === ts.name.toLowerCase() ? trustedCtx : undefined),
}, handler);
function useTrustedCert() {
  if (!ts.cert) return;
  try { trustedCtx = tls.createSecureContext({ key: ts.cert.key, cert: ts.cert.cert, minVersion: 'TLSv1.2' }); } catch (e) { console.log('  ! Trusted certificate could not be used:', e.message); }
}
for (const s of [httpServer, httpsServer]) {
  s.keepAliveTimeout = 65000;
  s.headersTimeout = 20000;  // slow-header attacks get cut off
  s.requestTimeout = 0;      // but long movie downloads are fine
  s.on('clientError', (e, sock) => sock.destroy());
}

function onFrontConnection(sock) {
  sock.on('error', () => {});
  if (!guard.admit(sock)) { sock.destroy(); return; }
  sock.setTimeout(15000, () => sock.destroy()); // silent connections are dropped
  sock.once('data', buf => {
    sock.setTimeout(0);
    sock.pause();
    sock.unshift(buf);
    (buf[0] === 0x16 ? httpsServer : httpServer).emit('connection', sock);
    process.nextTick(() => sock.resume());
  });
}
const front = net.createServer(onFrontConnection);
// Also answer on this PC's IPv6 address (::1), so "localhost" works in every browser. If another
// program already sits there, say so: that's what makes http://localhost:8765 show an empty page.
let localV6Note = null;
function listenLocalV6() {
  if (!['0.0.0.0', ''].includes(String(config.bind || ''))) return;
  const v6 = net.createServer(onFrontConnection);
  v6.on('error', e => {
    localV6Note = e.code === 'EADDRINUSE' ? `another program is using [::1]:${config.port}` : e.code || e.message;
    if (e.code === 'EADDRINUSE') console.log(`  ! Another program on this PC is using [::1]:${config.port}, so http://localhost:${config.port} may not open
    Watch Party. Use http://127.0.0.1:${config.port}/host/... instead (that's what Watch Party opens).
`);
  });
  try { v6.listen(config.port, '::1'); } catch { /* no IPv6 on this PC */ }
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
function onUpgrade(req, socket, head) {
  const u = new URL(req.url, 'http://x');
  const local = isLocal(req);
  const role = room.roleForKey(u.searchParams.get('k'), local);
  // the page must come from this same address (blocks other websites from connecting)
  let originOk = true;
  if (req.headers.origin) { try { const oh = new URL(req.headers.origin).host; originOk = oh === req.headers.host || oh === effectiveHost(req); } catch { originOk = false; } }
  if (u.pathname !== '/ws' || !role || !originOk || (!local && !isSecure(req) && config.linkMode !== 'plain')) {
    if (!local && !room.hasAdmittedIp(clientIp(req))) guard.strike(clientIp(req), 'websocket');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    const reqInfo = { host: req.headers.host, funnel: viaFunnel(req) };
    room.onConnection(ws, u.searchParams.get('k'), { iceFor: () => iceServersFor(reqInfo), relayOnly: () => !directCams(), local, ip: clientIp(req) });
  });
}
httpServer.on('upgrade', onUpgrade);
httpsServer.on('upgrade', onUpgrade);
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 20000);

// ---------------- startup ----------------
function openBrowser(url) {
  if (flag('--no-open')) return;
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {}
}

let lastPrinted = null;
// A small status file (for troubleshooting): which link friends get and why. No room key in it.
setInterval(() => {
  try {
    fs.writeFileSync(path.join(ROOT, config.cacheDir || 'cache', 'status.json'), JSON.stringify({
      at: new Date().toISOString(), pid: process.pid, localV6: localV6Note || 'ok', inviteBase: (joinUrl() || '').split('/join/')[0] || null, router: mapper.state.status,
      tailscale: { tool: ts.bin, name: ts.name, online: ts.online, trusted: !!ts.cert, funnelWanted: !!config.publicLink, funnelOn: !!ts.funnel.on, funnelError: ts.funnel.error, statusError: ts.statusError },
      webcams: { mode: config.webcamMode, direct: directCams(), cloudflare: !!cfTurn.servers, cloudflareError: cfTurn.error },
    }, null, 2));
  } catch { /* ignore */ }
}, 10000);
async function printInvite() {
  const url = joinUrl();
  if (!url || url === lastPrinted) {
    if (!url && !['searching', 'idle'].includes(mapper.state.status)) {
      console.log(`\n  ! No public link yet: ${mapper.state.error || 'router did not open the port'}\n    Open the host page, Room tab, for what to do.\n`);
    }
    return;
  }
  lastPrinted = url;
  console.log('\n  Invite link for your friends:\n\n    ' + url + '\n');
  try { console.log(await QRCode.toString(url, { type: 'terminal', small: true })); } catch {}
}

front.on('error', async e => {
  if (e.code === 'EADDRINUSE') {
    // Most likely Watch Party is already running (in the background): just open its page again.
    const hostUrl = `${localBase()}/host/${config.adminKey}`;
    // Ask it directly on 127.0.0.1 and ::1 (Windows sometimes resolves "localhost" to the one Watch
    // Party isn't listening on), and as a fallback check the status file the running copy keeps fresh.
    const ask = host => new Promise(resolve => {
      const r = http.get({ host, port: config.port, path: '/', timeout: 4000, headers: { Host: `localhost:${config.port}` } }, res => { res.resume(); resolve(res.statusCode === 302 && String(res.headers.location || '') === `/host/${config.adminKey}`); });
      r.on('error', () => resolve(false)); r.on('timeout', () => { r.destroy(); resolve(false); });
    });
    const aliveByStatus = () => {
      try {
        const st = JSON.parse(fs.readFileSync(path.join(ROOT, config.cacheDir || 'cache', 'status.json'), 'utf8'));
        if (!st.pid || st.pid === process.pid || Date.now() - Date.parse(st.at) > 30000) return false;
        process.kill(st.pid, 0); // throws if that process is gone
        return true;
      } catch { return false; }
    };
    const ours = (await ask('127.0.0.1')) || (await ask('::1')) || aliveByStatus();
    if (ours) {
      console.log('  Watch Party is already running. Opening its page.');
      openBrowser(hostUrl);
      setTimeout(() => process.exit(0), 1500);
      return;
    }
    console.error(`\n  Port ${config.port} is already in use by another program.\n`);
    notify(`Watch Party can't start: port ${config.port} is being used by another program. Close it, or change "port" in config.json.`);
  } else { console.error(e); notify(`Watch Party couldn't start: ${e.message}`); }
  setTimeout(() => process.exit(1), 8000);
});

front.listen(config.port, config.bind, async () => {
  listenLocalV6();
  const hostUrl = `${localBase()}/host/${config.adminKey}`;
  console.log('\n  ==============================================');
  console.log('   Watch Party is running');
  console.log('  ==============================================\n');
  console.log('  Your host page (keep this private):\n    ' + hostUrl + '\n');
  console.log('  Watch Party runs in the background. It stops by itself a few seconds after you close its');
  console.log('  page. Double-click WatchParty.exe again any time to reopen the page.\n');
  if (updatePending()) console.log('  ! An update is waiting but is not installed yet. Close this window and\n    double-click "refresh.bat" (not WatchParty.exe) to install it.\n');
  if (!bins.ffmpeg || !bins.ffprobe) console.log('  ! ffmpeg was not found in the "bin" folder. MKV files will not work.\n');
  openBrowser(hostUrl);
  try { await turn.start(); turnOk = true; } catch (e) { console.log(`  ! Webcam relay could not start on UDP ${config.port}: ${e.message}`); }
  if (tunnel) {
    tunnel.on('change', () => { room.broadcastHosts({ type: 'network' }); if (tunnel.status === 'up') printInvite(); });
    tunnel.start();
  }
  if (!config.keepPrepared) { const { freed, n } = library.clearPrepared(); if (n) console.log(`  Deleted ${n} leftover prepared file(s), ${sizeText(freed)} freed.`); }
  library.scan().catch(e => console.error('scan failed', e));
  startNetwork().catch(e => console.error('network setup failed', e));
  toolState.encoders = await tools.detectEncoders(bins.ffmpeg);
});
tools.hasDoviStrip(bins.ffmpeg).then(v => { toolState.dovi = v; if (!v && bins.ffmpeg) console.log('  ! This ffmpeg can\'t remove Dolby Vision. Dolby Vision movies may show a black screen.'); });

// Keep Windows from going to sleep while the app is open (stops automatically when the app closes).
let awake = null;
(function keepAwake() {
  if (process.platform !== 'win32' || flag('--allow-sleep')) return;
  const ps = `$s='[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);';` +
    `$t=Add-Type -MemberDefinition $s -Name P -Namespace W -PassThru;` +
    `while ($true) { $t::SetThreadExecutionState(0x80000001) | Out-Null; if (-not (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue)) { break }; Start-Sleep 30 }`;
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  try { awake = spawn('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], { stdio: 'ignore', windowsHide: true }); awake.on('error', () => {}); } catch {}
})();

// Stop by itself a few seconds after the host page is closed (a reload or switching to the
// "watch here" window reconnects well within that). Not while a movie is being prepared.
let hostSeen = false, noHostSince = Date.now(), longestGap = 0;
const STOP_AFTER_MS = Number(process.env.WP_STOP_AFTER_MS) || 5000;
setInterval(() => {
  const host = [...room.clients.values()].some(c => c.role === 'host');
  if (host) {
    if (hostSeen && process.env.WP_DEBUG_GAPS) { const gap = Date.now() - noHostSince; if (gap > 600) { longestGap = Math.max(longestGap, gap); console.log(`  (host page was away ${gap} ms, longest ${longestGap} ms)`); } }
    hostSeen = true; noHostSince = Date.now(); return;
  }
  if (library.running) { noHostSince = Date.now(); return; }
  const limit = hostSeen ? STOP_AFTER_MS : 10 * 60 * 1000; // never opened at all: give it 10 minutes
  if (!flag('--stay') && !shuttingDown && Date.now() - noHostSince > limit) {
    console.log(hostSeen ? '  The host page was closed. Stopping.' : '  The host page was never opened. Stopping.');
    shutdown();
  }
}, 500);

const sizeText = b => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (awake) { try { awake.kill(); } catch {} }
  if (tunnel) tunnel.stop();
  library.shutdown();
  room.shutdown();
  // prepared copies are big (often as big as the movie): delete them unless you asked to keep them
  if (!config.keepPrepared) {
    await new Promise(r => setTimeout(r, 600)); // let a stopped conversion let go of its file
    const { freed, n } = library.clearPrepared();
    if (n) console.log(`  Deleted ${n} prepared file(s), ${sizeText(freed)} freed.`);
  }
  turn.stop();
  // close the router port and the public link again (best effort, quick); the public link comes back next start
  // and disconnect Tailscale (it's connected again next start)
  const tsOff = (ts.funnel.on ? ts.setFunnel(false).then(() => { ts.funnel.on = false; }) : Promise.resolve()).then(() => ts.down());
  await Promise.race([Promise.all([mapper.stop(), ts.present ? tsOff : null]), new Promise(r => setTimeout(r, 6000))]);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown); // closing the console window on Windows
