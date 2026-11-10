'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { PlayerLifecycle } = require('../server/lifecycle');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('private windows do not expire on inactivity, and reloads cancel a pending close', () => {
  let now = 0;
  const lifecycle = new PlayerLifecycle({ now: () => now, closeGraceMs: 100 });
  const window = (id, action, sequence) => lifecycle.window({ id, action, sequence });
  window('firstwindow1', 'open', 1);
  now = 24 * 3600e3;
  assert.equal(lifecycle.playerClosed(), false);
  window('firstwindow1', 'close', 3);
  window('firstwindow1', 'open', 2); // late heartbeat cannot undo close
  now += 50;
  window('reloadwindow', 'open', 1);
  now += 500;
  assert.equal(lifecycle.playerClosed(), false);
  window('reloadwindow', 'close', 2);
  now += 101;
  assert.equal(lifecycle.playerClosed(), true);
});

test('all private windows must close; an inactive open window never expires', () => {
  let now = 0;
  const lifecycle = new PlayerLifecycle({ now: () => now, closeGraceMs: 10 });
  lifecycle.window({ id: 'firstwindow1', action: 'open', sequence: 1 });
  lifecycle.window({ id: 'otherwindow1', action: 'open', sequence: 1 });
  lifecycle.window({ id: 'firstwindow1', action: 'close', sequence: 2 });
  now = 101;
  assert.equal(lifecycle.playerClosed(), false);
  lifecycle.window({ id: 'otherwindow1', action: 'activity', sequence: 2 });
  assert.equal(lifecycle.window({ id: '../invalid', action: 'close', sequence: 1 }), false);
  now += 24 * 3600e3;
  assert.equal(lifecycle.playerClosed(), false);
});

test('browser window tracking survives backgrounding, reports departure with keepalive, and resumes from cache', async () => {
  const calls = [], listeners = {}, timers = new Map(), events = {};
  const context = vm.createContext({ window: {}, document: {}, fetch() {}, setInterval, clearInterval, Date });
  const source = fs.readFileSync(path.join(__dirname, '../public/js/player-window.js'), 'utf8');
  vm.runInContext(source.replace('export function', 'function'), context);
  context.trackPlayerWindow('host-key', {
    id: 'firstwindow1', target: { addEventListener: (name, fn) => { listeners[name] = fn; } },
    doc: { addEventListener: (name, fn) => { events[name] = fn; } },
    request: async (url, options) => { calls.push({ url, options, body: JSON.parse(options.body) }); },
    every: fn => { timers.set(1, fn); return 1; }, cancel: id => timers.delete(id),
  });
  assert.equal(calls[0].body.action, 'open');
  timers.get(1)(); // background heartbeat is presence, not activity
  assert.equal(calls.at(-1).body.action, 'open');
  assert.equal(events.visibilitychange, undefined);
  events.keydown();
  assert.equal(calls.at(-1).body.action, 'activity');
  listeners.pagehide({ persisted: true });
  assert.equal(calls.at(-1).body.action, 'activity');
  listeners.pagehide({ persisted: false });
  assert.equal(calls.at(-1).body.action, 'close');
  assert.equal(calls.at(-1).options.keepalive, true);
  assert.equal(calls.at(-1).options.headers['X-Admin-Key'], 'host-key');
  assert.equal(timers.size, 0);
  listeners.pageshow();
  assert.equal(calls.at(-1).body.action, 'open');
  assert.ok(calls.every((call, index) => call.body.sequence === index + 1));
});

async function fixture(t, { idleMs = 60000, setupDelay = 0, alreadyOnline = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-party-lifecycle-'));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ port, bind: '127.0.0.1', linkMode: 'plain',
    adminKey: 'testhostsecret', roomKey: 'testguestsecret1234', publicLink: true, room: { requireApproval: false } }));
  const script = `
    const fs = require('node:fs'), path = require('node:path');
    const root = process.argv[1], server = process.argv[2];
    const log = name => fs.appendFileSync(path.join(root, 'network.log'), name + '\\n');
    const tools = require(path.join(server, 'tools'));
    tools.ROOT = root; tools.findBin = () => null;
    tools.detectEncoders = async () => null; tools.hasDoviStrip = async () => true;
    const setup = require(path.join(server, 'extension-setup'));
    setup.createExtensionSetup = () => ({ info: () => null, install: async () => { log('extension:install'); return { ok: true }; }, open: async options => {
      log('extension:' + JSON.stringify(options)); return { ok: true, folderOpened: !!options.folder };
    } });
    const { PortMapper } = require(path.join(server, 'upnp'));
    PortMapper.prototype.start = async function () { log('router:start'); this.set({ status: 'mapped' }); };
    PortMapper.prototype.stop = async function () { log('router:stop'); };
    const { TurnServer } = require(path.join(server, 'turn'));
    TurnServer.prototype.start = async function () { log('relay:start'); };
    TurnServer.prototype.stop = function () { log('relay:stop'); };
    const { Tailscale } = require(path.join(server, 'tailscale'));
    Object.defineProperty(Tailscale.prototype, 'present', { get: () => true });
    Tailscale.prototype.refresh = async function () { log('tailscale:refresh'); ${alreadyOnline ? 'this.online = true;' : ''} };
    Tailscale.prototype.up = async function () { log('tailscale:up'); await new Promise(r => setTimeout(r, ${setupDelay})); this.online = true; };
    Tailscale.prototype.down = async function () { log('tailscale:down'); this.online = false; };
    Tailscale.prototype.ensureCert = async () => null;
    Tailscale.prototype.refreshFunnel = async () => {};
    Tailscale.prototype.setFunnel = async function (on) { log('funnel:' + on); this.funnel.on = on; return true; };
    const { Room } = require(path.join(server, 'room'));
    const hello = Room.prototype.hello;
    Room.prototype.hello = function (...args) {
      const client = hello.apply(this, args);
      if (args[3].watching) { this.movie = { id: 'playing-title', title: 'Playing title', kind: 'youtube', url: 'https://www.youtube.com/watch?v=abcdefghijk' }; this.state.playing = true; }
      return client;
    };
    process.argv = [process.execPath, path.join(server, 'index.js'), '--no-open', '--allow-sleep'];
    require(path.join(server, 'index.js'));
  `;
  const child = spawn(process.execPath, ['-e', script, root, path.resolve(__dirname, '../server')], {
    env: { ...process.env, WP_TEST_REMOTE_HOST: 'guest.test', WP_SERVER_IDLE_MS: String(idleMs), WP_STOP_AFTER_MS: '100' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await exited; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const request = (url, { body, guest = false, cookie = '', key = 'testhostsecret' } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method: body ? 'POST' : 'GET', headers: {
      Host: guest ? 'guest.test' : `127.0.0.1:${port}`, 'X-Admin-Key': key, 'Content-Type': 'application/json', Cookie: cookie,
    } }, res => {
      let text = ''; res.on('data', data => { text += data; });
      res.on('end', () => { let data; try { data = JSON.parse(text); } catch {} resolve({ code: res.statusCode, data, headers: res.headers }); });
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  let lastResponse;
  const until = async check => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) { if (await check()) return; await delay(40); }
    assert.fail(`Timed out waiting for server (${JSON.stringify(lastResponse)}): ${output}`);
  };
  await until(async () => { try { lastResponse = await request('/api/info'); return lastResponse.code === 200; } catch (error) { lastResponse = error.message; return false; } });
  const networkLog = () => fs.existsSync(path.join(root, 'network.log')) ? fs.readFileSync(path.join(root, 'network.log'), 'utf8') : '';
  const window = (action, sequence) => request('/api/player/window', { body: { id: 'firstwindow1', action, sequence } });
  const connect = async (role, extra = {}) => {
    const guest = role === 'guest';
    const join = guest ? await request('/join/testguestsecret1234', { guest: true }) : null;
    const cookie = join?.headers['set-cookie']?.map(value => value.split(';')[0]).join('; ') || '';
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?k=${guest ? 'testguestsecret1234' : 'testhostsecret'}`, { headers: guest ? { Host: 'guest.test', Cookie: cookie } : {} });
    t.after(() => socket.terminate());
    await new Promise(resolve => socket.once('open', resolve));
    const welcome = new Promise(resolve => socket.on('message', data => { const msg = JSON.parse(data); if (msg.type === 'welcome') resolve(msg); }));
    socket.send(JSON.stringify({ type: 'hello', clientId: role + 'client1', ...extra }));
    await welcome;
    return socket;
  };
  return { child, exited, request, until, networkLog, window, port, connect, root };
}

test('only an authenticated local host POST can open native extension setup', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const body = { browser: 'brave', folder: true };
  assert.notEqual((await f.request('/api/extension/setup', { body, key: 'wrong-key' })).code, 200);
  assert.notEqual((await f.request('/api/extension/setup', { body, guest: true })).code, 200);
  assert.notEqual((await f.request('/api/extension/setup')).code, 200);
  assert.doesNotMatch(f.networkLog(), /extension:/);
  const result = await f.request('/api/extension/setup', { body });
  assert.equal(result.code, 200);
  assert.equal(result.data.folderOpened, true);
  assert.match(f.networkLog(), /extension:\{"browser":"brave","folder":true\}/);
  assert.notEqual((await f.request('/api/extension/install', { body: {}, guest: true })).code, 200);
  assert.notEqual((await f.request('/api/extension/install', { body: {}, key: 'wrong' })).code, 200);
  assert.doesNotMatch(f.networkLog(), /extension:install/);
  assert.equal((await f.request('/api/extension/install', { body: {} })).code, 200);
});

test('native updater downloads and verifies the real extension package through the server', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const { download, unpack } = require('../server/extension-install');
  const bytes = await download(`http://127.0.0.1:${f.port}`, '');
  assert.equal(unpack(bytes).manifest.version, require('../extension/manifest.json').version);
  assert.notEqual((await f.request('/extension/update-info', { guest: true })).code, 200);
});

test('private startup, manual sharing, guest disconnection, restart, and explicit window close', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  await f.window('open', 1);
  assert.equal((await f.request('/api/info')).data.server.status, 'stopped');
  assert.equal((await f.request('/api/info')).data.joinUrl, null);
  assert.equal(f.networkLog(), '');
  assert.equal((await f.request('/join/testguestsecret1234', { guest: true })).code, 404);
  assert.equal((await f.request('/api/server/start', { body: {}, key: 'wrong-key' })).code, 404);
  assert.equal((await f.request('/api/server/start', { body: {}, guest: true })).code, 404);
  assert.equal((await f.request('/api/settings', { body: { publicLink: true, cloudflareTurn: null } })).code, 200);
  assert.equal(f.networkLog(), ''); // saved settings cannot silently start networking
  const host = new WebSocket(`ws://127.0.0.1:${f.port}/ws?k=testhostsecret`);
  await new Promise(resolve => host.once('open', resolve));
  host.send(JSON.stringify({ type: 'hello', clientId: 'testhost1' }));
  host.close();
  await delay(800); // well past the old socket-based shutdown and close grace
  assert.equal((await f.request('/api/info')).code, 200);
  await f.request('/api/server/start', { body: {} });
  await f.until(async () => (await f.request('/api/info')).data.server.status === 'running');
  assert.match(f.networkLog(), /tailscale:up/);
  assert.match(f.networkLog(), /funnel:true/);
  const join = await f.request('/join/testguestsecret1234', { guest: true });
  assert.equal(join.code, 200);
  const cookie = join.headers['set-cookie'].map(value => value.split(';')[0]).join('; ');
  const guest = new WebSocket(`ws://127.0.0.1:${f.port}/ws?k=testguestsecret1234`, { headers: { Host: 'guest.test', Cookie: cookie } });
  await new Promise(resolve => guest.once('open', resolve));
  const welcome = new Promise(resolve => guest.on('message', data => { if (JSON.parse(data).type === 'welcome') resolve(); }));
  guest.send(JSON.stringify({ type: 'hello', clientId: 'testguest1' }));
  await welcome;
  const disconnected = new Promise(resolve => guest.once('close', resolve));
  await f.request('/api/server/stop', { body: {} });
  await disconnected;
  await f.until(async () => (await f.request('/api/info')).data.server.status === 'stopped');
  assert.match(f.networkLog(), /tailscale:down/);
  assert.match(f.networkLog(), /funnel:false/);
  assert.equal((await f.request('/js/app.js', { guest: true, cookie })).code, 404);
  assert.equal((await f.request('/host/testhostsecret')).code, 200);
  await f.request('/api/server/start', { body: {} });
  await f.until(async () => (await f.request('/api/info')).data.server.status === 'running');
  assert.equal(f.networkLog().match(/tailscale:up/g).length, 2);
  await f.request('/api/server/stop', { body: {} });
  await f.until(async () => (await f.request('/api/info')).data.server.status === 'stopped');
  await f.window('close', 2);
  await f.until(() => f.child.exitCode !== null);
  assert.equal(await f.exited, 0);
});

test('solo and idle group sharing stay online until an explicit Stop server', { timeout: 15000 }, async t => {
  const f = await fixture(t, { idleMs: 400 });
  await f.window('open', 1);
  await f.request('/api/server/start', { body: {} });
  await f.until(async () => (await f.request('/api/info')).data.server.status === 'running');
  const host = await f.connect('host');
  await delay(1300);
  assert.equal((await f.request('/api/info')).data.server.status, 'running');
  const guest = await f.connect('guest');
  const guestClosed = new Promise(resolve => guest.once('close', resolve));
  await delay(1800);
  assert.equal((await f.request('/api/info')).data.server.status, 'running');
  assert.equal(guest.readyState, WebSocket.OPEN);
  await f.request('/api/server/stop', { body: {} });
  await f.until(async () => (await f.request('/api/info')).data.server.status === 'stopped');
  await guestClosed;
  assert.equal(host.readyState, WebSocket.OPEN);
  assert.equal((await f.request('/host/testhostsecret')).code, 200);
  assert.match(f.networkLog(), /tailscale:down/);
});

test('the lifecycle has no inactivity deadline, even after a day without activity', () => {
  let now = 0;
  const lifecycle = new PlayerLifecycle({ now: () => now });
  lifecycle.window({ id: 'firstwindow1', action: 'open', sequence: 1 });
  now += 24 * 3600e3;
  assert.equal(lifecycle.playerClosed(), false);
  assert.equal('idleMs' in lifecycle, false);
  lifecycle.window({ id: 'firstwindow1', action: 'close', sequence: 2 });
  now += lifecycle.closeGraceMs;
  assert.equal(lifecycle.playerClosed(), true);
});

for (const kind of ['cam', 'mic']) test(`turning ${kind} off does not stop sharing`, { timeout: 15000 }, async t => {
  const f = await fixture(t, { idleMs: 700 });
  await f.window('open', 1);
  await f.request('/api/server/start', { body: {} });
  await f.until(async () => (await f.request('/api/info')).data.server.status === 'running');
  const host = await f.connect('host');
  await f.connect('guest');
  host.send(JSON.stringify({ type: 'media', [kind]: true }));
  await delay(1800);
  assert.equal((await f.request('/api/info')).data.server.status, 'running');
  host.send(JSON.stringify({ type: 'media', cam: false, mic: false }));
  await delay(1800);
  assert.equal((await f.request('/api/info')).data.server.status, 'running');
  await f.request('/api/server/stop', { body: {} });
  await f.until(async () => (await f.request('/api/info')).data.server.status === 'stopped');
  assert.equal(host.readyState, WebSocket.OPEN);
});

test('closing the app shuts down active sharing, removes generated cache, and preserves history', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await f.window('open', 1);
  await f.request('/api/server/start', { body: {} });
  await f.until(async () => (await f.request('/api/info')).data.server.status === 'running');
  await f.connect('host', { watching: true });
  await f.connect('guest');
  const saved = JSON.stringify({ version: 3, episodes: [], playback: [{ title: 'Saved movie', position: 120 }] });
  fs.writeFileSync(path.join(f.root, 'watch-history.json'), saved);
  fs.writeFileSync(path.join(f.root, 'cache', '123456abcdef.mp4'), 'prepared');
  await f.window('close', 2);
  await f.until(() => f.child.exitCode !== null);
  assert.equal(await f.exited, 0);
  assert.match(f.networkLog(), /funnel:false/);
  assert.equal(fs.existsSync(path.join(f.root, 'cache', '123456abcdef.mp4')), false);
  assert.equal(fs.readFileSync(path.join(f.root, 'watch-history.json'), 'utf8'), saved);
});

test('stopping during setup prevents a late Funnel startup', { timeout: 15000 }, async t => {
  const f = await fixture(t, { setupDelay: 300 });
  await f.request('/api/server/start', { body: {} });
  await f.until(() => f.networkLog().includes('tailscale:up'));
  await f.request('/api/server/stop', { body: {} });
  await f.until(async () => (await f.request('/api/info')).data.server.status === 'stopped');
  assert.doesNotMatch(f.networkLog(), /funnel:true/);
  assert.match(f.networkLog(), /tailscale:down/);
});

test('active playback keeps sharing alive and manual stop preserves the host timeline', { timeout: 15000 }, async t => {
  const f = await fixture(t, { idleMs: 400 });
  const host = new WebSocket(`ws://127.0.0.1:${f.port}/ws?k=testhostsecret`);
  t.after(() => host.terminate());
  await new Promise(resolve => host.once('open', resolve));
  const welcome = new Promise(resolve => host.on('message', data => { if (JSON.parse(data).type === 'welcome') resolve(); }));
  host.send(JSON.stringify({ type: 'hello', clientId: 'watchinghost1', watching: true }));
  await welcome;
  await f.request('/api/server/start', { body: {} });
  await f.until(async () => (await f.request('/api/info')).data.server.status === 'running');
  await delay(1300);
  assert.equal((await f.request('/api/info')).data.server.status, 'running');
  await f.request('/api/server/stop', { body: {} });
  await f.until(async () => (await f.request('/api/info')).data.server.status === 'stopped');
  assert.equal(host.readyState, WebSocket.OPEN);
  // A second host can inspect the same movie and timeline after sharing stops.
  const inspect = new WebSocket(`ws://127.0.0.1:${f.port}/ws?k=testhostsecret`);
  t.after(() => inspect.terminate());
  await new Promise(resolve => inspect.once('open', resolve));
  const snapshot = new Promise(resolve => inspect.on('message', data => { const msg = JSON.parse(data); if (msg.type === 'welcome') resolve(msg); }));
  inspect.send(JSON.stringify({ type: 'hello', clientId: 'inspecthost1' }));
  const after = await snapshot;
  assert.equal(after.movie.id, 'playing-title');
  assert.equal(after.state.playing, true);
});

test('stopping sharing leaves a pre-existing Tailscale connection running', { timeout: 15000 }, async t => {
  const f = await fixture(t, { alreadyOnline: true });
  await f.request('/api/server/start', { body: {} });
  await f.until(async () => (await f.request('/api/info')).data.server.status === 'running');
  await f.request('/api/server/stop', { body: {} });
  await f.until(async () => (await f.request('/api/info')).data.server.status === 'stopped');
  assert.doesNotMatch(f.networkLog(), /tailscale:up|tailscale:down/);
  assert.match(f.networkLog(), /funnel:false/);
});
