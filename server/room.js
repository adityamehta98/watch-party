'use strict';
// The watch party room: who is here, what they may do, and the shared playback timeline.
const crypto = require('crypto');
const services = require('./services');
const anime = require('./anime');

const PERMS = ['playback', 'chat', 'react', 'camera'];
const REACTIONS = ['😂', '😮', '😍', '👏', '🔥', '😱', '😢', '💀', '❤️', '👀'];
const START_DELAY_MS = 250; // fallback start delay when the click time is unknown
const RESUME_DELAY_MS = 700;

function randKey(n) {
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += chars[bytes[i] % chars.length];
  return s;
}
const cleanName = n => String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 32);
const cleanId = n => (/^[A-Za-z0-9_-]{6,40}$/.test(String(n || '')) ? String(n) : null);

class Room {
  constructor({ config, library, save, ytSearch, animeSearch, animeResolve }) {
    this.config = config;
    this.library = library;
    this.save = save;
    this.ytSearch = ytSearch || null;
    this.animeSearch = animeSearch || anime.search;
    this.animeResolve = animeResolve || anime.resolveStream;
    this.jobOwner = new Map(); // movie id -> who started preparing it
    // The secret in the invite link (about 140 bits: unguessable). It's kept in config.json, so the
    // link stays the same every time Watch Party starts; "Make a new invite link" replaces it.
    if (!/^[A-Za-z0-9]{16,64}$/.test(String(config.roomKey || ''))) { config.roomKey = randKey(24); if (save) save(); }
    this.roomKey = config.roomKey;
    this.clients = new Map();   // clientId -> client
    this.memory = new Map();    // clientId -> { name, perms, admitted } (survives refresh / reconnect)
    this.banned = new Set();
    this.chat = [];
    this.bookmarks = [];
    this.syncEvents = []; // ephemeral observability only; never written to config or disk
    this.movie = null;
    this.state = { movieId: null, playing: false, position: 0, anchor: 0, seq: 0, waiting: false, waitingFor: [] };
    this.waitStart = 0;
    const s = config.room || {};
    this.settings = {
      autoWait: s.autoWait !== false,
      requireApproval: s.requireApproval !== false, // on by default: you approve each new guest
      maxGuests: Math.max(1, Math.min(20, Number(s.maxGuests) || 8)),
      locked: false,
      defaults: { playback: true, chat: true, react: true, camera: true, ...(s.defaults || {}) },
    };
    this.lastPeopleJson = { host: '', guest: '' };
    this.lastObservatoryJson = '';
    this.recentLeft = new Map(); // quiet "left/joined" noise when someone just refreshes
    this.timer = setInterval(() => this.tick(), 500);
  }

  get adminKey() { return this.config.adminKey; }

  // ---------------- connection lifecycle ----------------
  // The host key only works from this PC itself; over the internet only the invite key works.
  roleForKey(key, local = false) {
    if (local && key && key === this.adminKey) return 'host';
    if (key && key === this.roomKey) return 'guest';
    return null;
  }

  onConnection(ws, key, ctx = {}) {
    const role = this.roleForKey(key, !!ctx.local);
    if (!role) { ws.close(4004, 'bad-key'); return; }
    let client = null;
    const helloTimer = setTimeout(() => { if (!client) ws.close(4005, 'no-hello'); }, 10000);
    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'ping') { this.send(ws, { type: 'pong', t0: msg.t0, ts: Date.now() }); return; }
      if (!client) {
        if (msg.type === 'hello') { clearTimeout(helloTimer); client = this.hello(ws, role, key, msg, ctx); }
        return;
      }
      if (client.ws !== ws) return; // replaced by a newer tab
      const now = Date.now();
      if (now - (client.floodStart || 0) > 1000) { client.floodStart = now; client.floodCount = 0; }
      if (++client.floodCount > 300) { try { ws.close(4006, 'flood'); } catch {} return; } // way more than any real browser sends
      try { this.onMessage(client, msg); } catch (e) { console.error('[room] message error', e); }
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (client && client.ws === ws) this.leave(client);
    });
    ws.on('error', () => {});
  }

  hello(ws, role, key, msg, ctx = {}) {
    const id = cleanId(msg.clientId) || randKey(16);
    const mem = this.memory.get(id);
    const name = cleanName(msg.name) || (mem && mem.name) || (role === 'host' ? 'Host' : 'Guest');
    if (role === 'guest' && this.banned.has(id)) { this.send(ws, { type: 'denied', reason: 'removed' }); ws.close(4003, 'banned'); return null; }
    if (role === 'guest' && this.settings.locked && !(mem && mem.admitted)) { this.send(ws, { type: 'denied', reason: 'locked' }); ws.close(4003, 'locked'); return null; }
    const guests = [...this.clients.values()].filter(c => c.role === 'guest' && c.id !== id).length;
    if (role === 'guest' && guests >= this.settings.maxGuests) { this.send(ws, { type: 'denied', reason: 'full' }); ws.close(4003, 'full'); return null; }
    const old = this.clients.get(id);
    if (old) { this.send(old.ws, { type: 'replaced' }); try { old.ws.close(4000, 'replaced'); } catch {} this.leave(old, true); }
    const perms = role === 'host' ? Object.fromEntries(PERMS.map(p => [p, true])) : { ...this.settings.defaults, ...((mem && mem.perms) || {}) };
    const client = {
      id, name, role, ws, key, perms, iceFor: ctx.iceFor || (() => []), relayOnlyFor: ctx.relayOnly || (() => true), ip: ctx.ip || '',
      // nativeHls: Safari / iPhone / iPad, the only browsers that play the stream with their own HLS player
      capabilities: { hls: !!msg.capabilities?.hls, mse: !!msg.capabilities?.mse, nativeHls: !!(msg.capabilities?.hls && msg.capabilities?.nativeHlsPreferred) },
      admitted: role === 'host' || !this.settings.requireApproval || !!(mem && mem.admitted),
      media: { cam: false, mic: false },
      status: { at: 0 }, bufferingSince: null, lastWaitCause: 0,
      metrics: { corrections: [], lastCorrection: '' },
      bytes: 0, lastBytes: 0, mbps: 0, joinedAt: Date.now(), lastReact: [],
    };
    this.clients.set(id, client);
    this.memory.set(id, { name, perms, admitted: client.admitted });
    if (role === 'guest') console.log(`  ${client.admitted ? 'Joined' : 'Waiting to join'}: "${name}" from ${client.ip}`);
    if (!client.admitted) {
      this.send(ws, { type: 'pending', you: { id, name } });
      this.broadcastHosts({ type: 'toast', kind: 'knock', text: `${name} wants to join`, name, clientId: id });
      this.broadcastPeople(true);
      return client;
    }
    this.admit(client, !!old);
    return client;
  }

  admit(client, isReconnect) {
    client.admitted = true;
    const mem = this.memory.get(client.id);
    if (mem) mem.admitted = true;
    this.send(client.ws, {
      type: 'welcome',
      you: { id: client.id, name: client.name, role: client.role, perms: client.perms },
      state: this.state, movie: this.publicMovie(), chat: this.chat.slice(-60), bookmarks: this.bookmarks,
      peers: this.admitted().filter(c => c !== client).map(c => ({ id: c.id, name: c.name, media: c.media })),
      settings: this.publicSettings(client.role === 'host'),
      iceServers: client.iceFor(), relayOnly: client.relayOnlyFor(), reactions: REACTIONS, serverTime: Date.now(),
    });
    this.broadcast({ type: 'peer-join', peer: { id: client.id, name: client.name, media: client.media } }, client);
    if (this.recentLeft.has(client.id)) { clearTimeout(this.recentLeft.get(client.id)); this.recentLeft.delete(client.id); isReconnect = true; }
    if (!isReconnect) this.system(`${client.name} joined`);
    this.broadcastPeople(true);
  }

  leave(client, silent) {
    if (this.clients.get(client.id) !== client) return;
    this.clients.delete(client.id);
    if (client.admitted) {
      this.broadcast({ type: 'peer-leave', id: client.id });
      if (!silent) {
        clearTimeout(this.recentLeft.get(client.id));
        this.recentLeft.set(client.id, setTimeout(() => { this.recentLeft.delete(client.id); this.system(`${client.name} left`); }, 8000));
      }
    }
    this.broadcastPeople(true);
    this.checkWait();
  }

  admitted() { return [...this.clients.values()].filter(c => c.admitted); }
  hasAdmittedIp(ip) { return !!ip && this.admitted().some(c => c.role !== 'host' && c.ip === ip); }

  // The way webcams connect changed (public link switched on or off, a relay key added): tell
  // everyone, and the host reconnects the cameras with the new settings.
  updateIce() {
    const key = JSON.stringify([...new Set(this.admitted().map(c => JSON.stringify([c.iceFor(), c.relayOnlyFor()])))].sort());
    if (key === this.lastIceKey) return;
    this.lastIceKey = key;
    for (const c of this.admitted()) this.send(c.ws, { type: 'ice', iceServers: c.iceFor(), relayOnly: c.relayOnlyFor() });
  }

  // ---------------- messaging helpers ----------------
  send(ws, msg) {
    if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(msg)); } catch {} }
  }
  broadcast(msg, except) {
    const s = JSON.stringify(msg);
    for (const c of this.clients.values()) if (c.admitted && c !== except && c.ws.readyState === 1) { try { c.ws.send(s); } catch {} }
  }
  broadcastHosts(msg) {
    for (const c of this.clients.values()) if (c.role === 'host') this.send(c.ws, msg);
  }
  // Playback permission applies to transport only. Every admitted member may select content, while
  // arbitrary custom sites remain host-only through selectUrl's custom-site validation.
  canControl(client) { return !!client && (client.role === 'host' || (client.admitted && !!client.perms.playback && !this.customOn())); }
  canChoose(client) { return !!client && !!client.admitted; }
  customOn() { return !!(this.movie && this.movie.service === 'custom'); }
  // what a guest may see of the library: no folder names or paths on the host's PC
  guestLibrary() {
    const L = this.library.list();
    return {
      folders: L.folders.length ? ['(the host\'s movies)'] : [], scanning: L.scanning,
      items: L.items.map(it => ({ ...it, rel: String(it.rel || '').split(/[\\/]/).pop() })),
    };
  }
  system(text) {
    const m = { id: randKey(8), system: true, text, ts: Date.now() };
    this.pushChat(m);
    this.broadcast({ type: 'chat', message: m });
  }
  pushChat(m) { this.chat.push(m); if (this.chat.length > 200) this.chat.splice(0, this.chat.length - 200); }
  toast(client, text, kind = 'info') { this.send(client.ws, { type: 'toast', kind, text }); }

  publicSettings(isHost) {
    const s = { autoWait: this.settings.autoWait, safariExtensionUrl: this.config.safariExtensionUrl || '' };
    if (isHost) Object.assign(s, { requireApproval: this.settings.requireApproval, locked: this.settings.locked, maxGuests: this.settings.maxGuests, defaults: this.settings.defaults });
    return s;
  }

  broadcastSettings() {
    for (const c of this.clients.values()) if (c.admitted) this.send(c.ws, { type: 'settings', settings: this.publicSettings(c.role === 'host') });
  }

  publicMovie() {
    if (!this.movie) return null;
    const m = this.movie;
    if (m.kind === 'anime') {
      // Native-HLS anime: same <video> path as movies, plus the metadata the Next-episode button needs.
      return { id: m.id, kind: 'anime', service: 'anime', serviceName: 'Anime', title: m.title, duration: m.duration || null,
        url: null, hls: m.hlsPath || null, progressive: false,
        subs: (m.subs || []).map(s => ({ key: s.key, label: s.label, lang: s.lang, url: s.url })),
        intro: m.intro || null, outro: m.outro || null,
        anilistId: m.anilistId || null, malId: m.malId || null, episode: m.episode || null, episodes: m.episodes || null, language: m.language || null, animeTitle: m.animeTitle || null,
        browsing: false, by: m.by || null, strict: false };
    }
    if (m.kind !== 'file') {
      return { id: m.id, kind: m.kind, service: m.service, serviceName: m.serviceName, url: m.url, sources: m.sources || null, videoId: m.videoId, title: m.title, duration: m.duration, browsing: !!m.browsing, by: m.by || null, strict: !!m.strict, advanceFrom: m.advanceFrom || null,
        anilistId: m.anilistId || null, malId: m.malId || null, episode: m.episode || null, episodes: m.episodes || null, language: m.language || null, animeTitle: m.animeTitle || null };
    }
    return {
      kind: 'file', id: m.id, title: m.title, duration: m.duration, width: m.width, height: m.height, hdr: m.hdr, codec: m.codec,
      mbps: m.mbps, audio: m.audio, url: m.file ? `/media/${m.id}/video` : null,
      hls: m.hls ? `/media/${m.id}/hls/index.m3u8` : null, progressive: !!m.progressive,
      subs: m.subs.map(s => ({ key: s.key, label: s.label, lang: s.lang, url: `/media/${m.id}/sub/${s.key}.vtt` })),
    };
  }

  refreshLibraryMovie() {
    if (this.movie?.kind !== 'file') return;
    const playable = this.library.playable(this.movie.id);
    if (!playable) {
      if (!this.movie.progressive) return;
      this.movie = null;
      this.setState({ movieId: null, playing: false, position: 0, anchor: Date.now() });
      this.broadcast({ type: 'movie', movie: null });
      return;
    }
    const changed = !!this.movie.file !== !!playable.file || !!this.movie.hls !== !!playable.hls
      || !!this.movie.progressive !== !!playable.progressive || this.movie.subs.length !== playable.subs.length;
    this.movie = { ...playable, kind: 'file' };
    if (changed) this.broadcast({ type: 'movie', movie: this.publicMovie() });
  }

  people(forHost) {
    const list = [];
    for (const c of this.clients.values()) {
      if (!c.admitted && !forHost) continue;
      const st = c.status || {};
      list.push({
        id: c.id, name: c.name, role: c.role, admitted: c.admitted, perms: c.perms, media: c.media, ip: forHost && c.role !== 'host' ? c.ip : undefined,
        status: forHost ? {
          buffering: !!st.buffering, blocked: !!st.blocked, ahead: st.ahead == null ? null : Math.round(st.ahead),
          loaded: !!st.loaded, error: st.error || 0, stale: Date.now() - (st.at || 0) > 6000,
          stalls: st.stalls || 0, dev: st.dev || '', hls: !!c.capabilities?.nativeHls, waits: c.waits ? c.waits.length : 0, noWait: !!(c.noWaitUntil && c.noWaitUntil > Date.now()),
        } : { buffering: !!st.buffering, noWait: !!(c.noWaitUntil && c.noWaitUntil > Date.now()) },
        mbps: forHost ? Math.round(c.mbps * 10) / 10 : undefined,
      });
    }
    return list.sort((a, b) => (a.role === 'host' ? -1 : 0) - (b.role === 'host' ? -1 : 0) || a.name.localeCompare(b.name));
  }

  broadcastPeople(force) {
    const hostList = this.people(true);
    const guestMsg = JSON.stringify({ type: 'people', people: this.people(false) });
    const hostMsg = JSON.stringify({ type: 'people', people: hostList, totalMbps: Math.round(hostList.filter(p => p.role !== 'host').reduce((s, p) => s + (p.mbps || 0), 0) * 10) / 10 });
    const observatoryMsg = JSON.stringify({ type: 'observatory', observatory: this.observatory() });
    const hostChanged = force || hostMsg !== this.lastPeopleJson.host;
    const guestChanged = force || guestMsg !== this.lastPeopleJson.guest;
    const observatoryChanged = force || observatoryMsg !== this.lastObservatoryJson;
    this.lastPeopleJson = { host: hostMsg, guest: guestMsg };
    this.lastObservatoryJson = observatoryMsg;
    if (!hostChanged && !guestChanged && !observatoryChanged) return;
    for (const c of this.clients.values()) {
      if (!c.admitted || c.ws.readyState !== 1) continue;
      try {
        if (c.role === 'host') {
          if (hostChanged) c.ws.send(hostMsg);
          if (observatoryChanged) c.ws.send(observatoryMsg);
        } else {
          if (guestChanged) c.ws.send(guestMsg);
          if (observatoryChanged) c.ws.send(observatoryMsg);
        }
      } catch {}
    }
  }

  observatory() {
    if (!this.movie) return { confidence: null, participants: [], timeline: [], recommendations: [] };
    const now = Date.now();
    const watchers = this.admitted().filter(c => c.status && c.status.loaded);
    const participants = this.admitted().sort((a, b) => (a.role === 'host' ? -1 : 0) - (b.role === 'host' ? -1 : 0) || a.name.localeCompare(b.name)).map(c => {
      const st = c.status || {};
      return { id: c.id, name: c.name, status: {
        loaded: !!st.loaded, buffering: !!st.buffering, stale: now - (st.at || 0) > 6000,
        drift: st.drift, health: st.health, rtt: st.rtt, rate: st.rate,
        corrections: (c.metrics && c.metrics.corrections || []).slice(-12),
      } };
    });
    const scores = watchers.map(c => {
      const st = c.status;
      let score = 100;
      if (now - (st.at || 0) > 6000) score -= 45;
      if (st.buffering) score -= 35;
      if (!st.ready) score -= 10;
      score -= Math.min(25, Math.abs(st.drift || 0) / 20);
      score -= Math.min(12, Math.max(0, (st.rtt || 0) - 80) / 35);
      score -= Math.min(18, Math.max(0, 60 - (st.health == null ? 60 : st.health)) * 0.3);
      return Math.max(0, score);
    });
    const confidence = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
    const recommendations = [];
    if (this.movie.kind === 'file') {
      const currentHeight = Number(this.movie.height) || 2160;
      const currentMbps = Number(this.movie.mbps) || 0;
      const profiles = [{ h: 2160, mbps: 22 }, { h: 1080, mbps: 8 }, { h: 720, mbps: 4 }, { h: 480, mbps: 2 }];
      for (const c of watchers) {
        const st = c.status;
        if (c.role === 'host' || !(st.buffering || st.stalls >= 2 || st.health < 30)) continue;
        const budget = c.mbps > 0.3 ? c.mbps * 0.7 : currentMbps ? currentMbps * 0.55 : 4;
        const target = profiles.find(p => p.h < currentHeight && p.mbps <= budget);
        const text = target
          ? `A ${target.h}p streaming copy should prevent ${c.name} from buffering.`
          : `${c.name} should close downloads or switch to a faster connection.`;
        recommendations.push({ clientId: c.id, level: st.buffering ? 'urgent' : 'suggestion', text });
      }
    }
    return { confidence, participants, timeline: this.syncEvents.slice(-60), recommendations };
  }

  resetObservatory() {
    this.syncEvents = [];
    for (const c of this.clients.values()) c.metrics = { corrections: [], lastCorrection: '' };
  }

  // ---------------- timeline ----------------
  currentPosition(now = Date.now()) {
    const s = this.state;
    let p = s.playing ? s.position + Math.max(0, now - s.anchor) / 1000 : s.position;
    if (this.movie && this.movie.duration) p = Math.min(p, this.movie.duration);
    return Math.max(0, p);
  }

  setState(patch, meta = {}) {
    if ('movieId' in patch && patch.movieId !== this.state.movieId) {
      this.resetObservatory();
      this.bookmarks = [];
      this.broadcast({ type: 'bookmarks', bookmarks: [] });
    }
    this.state = { ...this.state, waiting: false, waitingFor: [], ...patch, seq: this.state.seq + 1 };
    this.broadcast({ type: 'state', state: this.state, by: meta.by || null, byId: meta.byId || null, ref: meta.ref || null, action: meta.action || null, serverTime: Date.now() });
  }

  command(client, msg) {
    if (!this.movie) return;
    if (!this.canControl(client)) {
      this.send(client.ws, { type: 'error', code: 'no-permission', perm: 'playback' });
      return;
    }
    const now = Date.now();
    const dur = this.movie.duration || Infinity;
    const clamp = p => Math.max(0, Math.min(Number(p) || 0, dur));
    const by = client.name;
    const ref = Number.isInteger(msg.ref) ? msg.ref : null; // lets the sender tell its own echoes apart
    // The person who clicked already reacted on their screen at the moment of the click (msg.at, in
    // room-clock time). Anchoring the timeline there means they feel no delay; everyone else lands on
    // the same timeline a moment later and the sync engine closes the gap.
    const at = Number(msg.at);
    const clickAnchor = Number.isFinite(at) && Math.abs(at - now) < 1500 ? Math.max(at, now - 500) : null;
    switch (msg.action) {
      case 'play': {
        const pos = msg.position != null ? clamp(msg.position) : this.currentPosition(now);
        this.setState({ playing: true, position: pos >= dur - 0.5 ? 0 : pos, anchor: clickAnchor != null ? clickAnchor : now + START_DELAY_MS }, { by, byId: client.id, ref, action: 'play' });
        break;
      }
      case 'pause': {
        // pause exactly on the frame the person saw (if it's plausible), not a few ms later
        const cur = this.currentPosition(now);
        const p = Number(msg.position);
        const pos = Number.isFinite(p) && Math.abs(p - cur) < 3 ? clamp(p) : cur;
        this.setState({ playing: false, position: pos, anchor: now }, { by, byId: client.id, ref, action: 'pause' });
        break;
      }
      case 'seek': {
        const pos = clamp(msg.position);
        const playing = this.state.playing || this.state.waiting;
        this.setState({ playing, position: pos, anchor: clickAnchor != null ? clickAnchor : now + (playing ? START_DELAY_MS : 0) }, { by, byId: client.id, ref, action: 'seek' });
        break;
      }
      default:
    }
  }

  selectMovie(client, id) {
    if (!this.canChoose(client)) return;
    if (!id) {
      this.movie = null;
      this.setState({ movieId: null, playing: false, position: 0, anchor: Date.now() });
      this.broadcast({ type: 'movie', movie: null });
      return;
    }
    const p = this.library.playable(id);
    if (!p) { this.toast(client, 'That movie needs to be prepared first.', 'error'); return; }
    this.movie = { ...p, kind: 'file' };
    this.broadcast({ type: 'movie', movie: this.publicMovie() });
    // Start playing right away so the host doesn't have to click Play after Show in room.
    this.setState({ movieId: id, playing: true, position: 0, anchor: Date.now() + 600 }, { by: client.name, action: 'play' });
    this.system(`Now showing: ${p.title}`);
  }

  // A YouTube / Netflix / Prime Video / ... link. Everyone watches from their own account or the embed.
  // opts.follow: the host's streaming tab moved on to another title by itself (the host clicked
  // something on Netflix, say), so the room follows it, starting from where that tab already is.
  selectUrl(client, url, inTabs, opts = {}) {
    if (!this.canChoose(client)) return;
    const previous = this.movie;
    // a custom site: only the host picks one, and the room follows the host's window around that site
    const custom = client.role === 'host' && (!!opts.custom || (!!opts.follow && this.customOn()));
    const info = services.identify(url, { custom });
    if (!info) {
      if (!opts.follow) this.toast(client, opts.custom ? 'That address can\'t be used. Paste the full https:// link of the page with the video.' : 'That link isn\'t from a supported service. Paste the link of the show or movie page.', 'error');
      return;
    }
    const kind = info.service === 'youtube' && !inTabs ? 'youtube' : 'service';
    // a custom site is locked down in everyone's window (no pop-ups, no new tabs) unless the host turned that off
    const strict = info.service === 'custom' ? (opts.custom ? opts.strict !== false : !(this.movie && this.movie.strict === false)) : false;
    const id = 'u' + crypto.createHash('sha1').update(info.url + (info.service === 'custom' && !strict ? '#loose' : '')).digest('hex').slice(0, 11);
    if (this.movie && this.movie.id === id) return;
    const browsing = !!opts.browsing; // the service's front page: the host is picking something
    const title = String(opts.title || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 140);
    const requestedFrom = opts.follow && opts.advanceFrom ? services.identify(opts.advanceFrom) : null;
    const advanceFrom = requestedFrom && previous && previous.kind === 'service' && previous.service === 'netflix' && info.service === 'netflix'
      && requestedFrom.url === previous.url && info.url !== previous.url ? previous.url : null;
    this.movie = { id, kind, service: info.service, serviceName: info.name, url: info.url, videoId: info.videoId || null, title: title || info.name, duration: Number(opts.duration) > 0 ? Number(opts.duration) : null, subs: [], browsing, by: client.name, strict, advanceFrom };
    this.broadcast({ type: 'movie', movie: this.publicMovie() });
    const pos = Math.max(0, Number(opts.position) || 0);
    this.setState({ movieId: id, playing: !!opts.playing && pos >= 0, position: pos, anchor: Date.now() + (opts.playing ? 300 : 0) }, { by: client.name, action: 'load' });
    this.system(browsing ? `${client.name} is picking something on ${info.name}` : `Now showing ${title ? `"${title}"` : 'something'} on ${info.name}`);
  }

  // Resolve a native HLS stream and play it in the shared <video>; fall back to the iframe embed.
  async selectAnime(client, msg) {
    if (!this.canChoose(client)) return;
    const anilistId = Math.trunc(Number(msg.anilistId));
    const malId = Math.max(0, Math.trunc(Number(msg.malId)) || 0);
    const episode = Math.max(1, Math.min(100000, Math.trunc(Number(msg.ep)) || 1));
    const episodes = Math.max(0, Math.min(100000, Math.trunc(Number(msg.episodes)) || 0));
    const language = msg.lang === 'dub' ? 'dub' : 'sub';
    const sources = anime.embedSources(anilistId, malId, episode, language);
    if (!sources.length) { this.toast(client, "That anime episode can't be played.", 'error'); return; }
    const id = 'a' + crypto.createHash('sha1').update(sources[0]).digest('hex').slice(0, 11);
    if (this.movie && this.movie.id === id) return;
    const base = String(msg.title || 'Anime').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 120) || 'Anime';
    const title = `${base} · Ep ${episode}${language === 'dub' ? ' (Dub)' : ''}`;
    const meta = { anilistId, malId, episode, episodes, language, animeTitle: base };

    // Resolve the native stream. Guard against a newer pick landing while we were awaiting.
    const seq = (this.animeSeq = (this.animeSeq || 0) + 1);
    let resolved = null;
    try { resolved = await this.animeResolve(anilistId, malId, episode, language); } catch { resolved = null; }
    if (seq !== this.animeSeq) return; // superseded by a later selection
    if (this.movie && this.movie.id === id) return;

    if (resolved && resolved.url) {
      const subs = (resolved.subtitles || []).slice(0, 12).map((t, i) => ({
        key: `s${i}`, label: String(t.label || `Track ${i + 1}`).slice(0, 60), lang: t.lang || '',
        url: anime.signedPath('sub', t.url, resolved.referer),
      }));
      this.movie = { id, kind: 'anime', service: 'anime', serviceName: 'Anime', title, duration: null,
        hlsPath: anime.signedPath('m3u8', resolved.url, resolved.referer), subs,
        intro: resolved.intro || null, outro: resolved.outro || null,
        browsing: false, by: client.name, strict: false, ...meta };
    } else {
      // Fallback: the old cross-origin iframe embed (ads + looser sync, but it still plays).
      this.movie = { id, kind: 'megaplay', service: 'anime', serviceName: 'Anime', url: sources[0], sources, videoId: null, title, duration: null, subs: [], browsing: false, by: client.name, strict: false, ...meta };
    }
    this.broadcast({ type: 'movie', movie: this.publicMovie() });
    // Start the room playing (with a load delay) so everyone advances together, and let auto-wait hold
    // for whoever is still loading instead of one player racing ahead.
    this.setState({ movieId: id, playing: true, position: 0, anchor: Date.now() + 1500 }, { by: client.name, action: 'play' });
    this.system(`Now showing "${title}" (Anime)`);
  }

  // The host's player learned the real title / length of a streaming title.
  movieMeta(client, msg) {
    const m = this.movie;
    // the host's player, or the player of whoever picked this title (never two players arguing)
    if (!m || m.kind === 'file' || msg.id !== m.id || !(client.role === 'host' || (this.canChoose(client) && m.by === client.name))) return;
    const title = String(msg.title || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 140);
    const dur = Number(msg.duration);
    let changed = false;
    if (title && title !== m.title) { m.title = title; changed = true; }
    if (dur > 0 && dur < 86400 && Math.abs((m.duration || 0) - dur) > 1) { m.duration = dur; changed = true; }
    if (changed) this.broadcast({ type: 'movie', movie: this.publicMovie() });
  }

  // "Pause for everyone when someone buffers"
  checkWait() {
    if (!this.movie) return;
    const now = Date.now();
    const s = this.state;
    const watchers = this.admitted().filter(c => {
      const st = c.status;
      return st && st.loaded && !st.blocked && now - (st.at || 0) < 5000;
    });
    // after a jump, streaming sites (Netflix & co) take a few seconds to load the new spot; that's
    // normal and not worth stopping everyone for
    const settle = this.movie.kind === 'file' ? 1500 : 4500;
    if (this.settings.autoWait && s.playing && now > s.anchor + settle) {
      const stalled = watchers.filter(c => c.bufferingSince && now - c.bufferingSince > 1500 && now - c.lastWaitCause > 20000
        && !(c.noWaitUntil && c.noWaitUntil > now));
      if (stalled.length) {
        for (const c of stalled) {
          c.lastWaitCause = now;
          // Someone who keeps buffering (a phone on weak Wi-Fi, say) would stop the movie for everyone
          // again and again. After 3 times in 4 minutes the room stops waiting for them for 15 minutes:
          // they catch up on their own (skipping what they missed) and the host is told why.
          c.waits = (c.waits || []).filter(t => now - t < 240000).concat(now);
          if (c.waits.length >= 3) {
            c.noWaitUntil = now + 15 * 60000;
            c.waits = [];
            this.broadcastHosts({ type: 'toast', kind: 'info', timeout: 12000, text: `${c.name} keeps buffering, so the room won't pause for them for a while. Check the People tab for why.` });
            this.send(c.ws, { type: 'toast', kind: 'info', text: 'Your connection keeps falling behind, so the movie no longer pauses for you. You\'ll catch up on your own.' });
          }
        }
        this.waitStart = now;
        this.state = { ...s, playing: false, position: this.currentPosition(now), anchor: now, seq: s.seq + 1, waiting: true, waitingFor: stalled.map(c => c.name) };
        this.broadcast({ type: 'state', state: this.state, by: null, action: 'wait', serverTime: now });
        return;
      }
    }
    if (s.waiting && !s.playing) {
      const notReady = watchers.filter(c => c.status.seq !== s.seq || !c.status.ready || c.status.buffering);
      if ((!notReady.length && now - this.waitStart > 800) || now - this.waitStart > 30000) {
        this.setState({ playing: true, position: s.position, anchor: now + RESUME_DELAY_MS }, { action: 'resume' });
      } else {
        const names = notReady.map(c => c.name);
        if (names.join('|') !== s.waitingFor.join('|')) {
          this.state = { ...s, waitingFor: names };
          this.broadcast({ type: 'state', state: this.state, by: null, action: 'wait', serverTime: now });
        }
      }
    }
  }

  tick() {
    const now = Date.now();
    if (!this._lastRate || now - this._lastRate >= 2000) {
      const dt = (now - (this._lastRate || now - 2000)) / 1000;
      this._lastRate = now;
      for (const c of this.clients.values()) {
        c.mbps = ((c.bytes - c.lastBytes) * 8) / 1e6 / dt;
        c.lastBytes = c.bytes;
      }
      this.broadcastPeople(false);
    }
    this.checkWait();
  }

  addBytes(clientId, n) {
    const c = this.clients.get(clientId);
    if (c) c.bytes += n;
  }

  // ---------------- messages ----------------
  onMessage(client, msg) {
    const isHost = client.role === 'host';
    if (!client.admitted) return;
    switch (msg.type) {
      case 'cmd': return this.command(client, msg);
      case 'status': {
        const st = msg.status || {};
        const previous = client.status || {};
        const now = Date.now();
        const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
        client.status = {
          buffering: !!st.buffering, ready: !!st.ready, loaded: !!st.loaded, blocked: !!st.blocked,
          ahead: st.ahead == null ? null : clamp(st.ahead, 0, 3600), drift: clamp(st.drift, -60000, 60000), error: clamp(st.error, 0, 999), seq: st.seq, at: now,
          health: clamp(st.health, 0, 100), rtt: clamp(st.rtt, 0, 10000), rate: clamp(st.rate || 1, 0.25, 4),
          stalls: Math.min(9999, Number(st.stalls) || 0), dev: String(st.dev || '').slice(0, 24),
        };
        if (client.status.error && !previous.error && client.capabilities?.nativeHls && this.movie?.kind === 'file' && !this.movie.hls) {
          this.broadcastHosts({ type: 'toast', kind: 'error', text: `${client.name}'s Safari could not play this copy. Prepare it again with “Instant start” enabled.` });
        }
        if (client.status.buffering) { if (!client.bufferingSince) client.bufferingSince = now; } else client.bufferingSince = null;
        if ((previous.at && previous.buffering !== client.status.buffering) || (!previous.at && client.status.buffering)) {
          this.syncEvents.push({ at: now, clientId: client.id, name: client.name, type: client.status.buffering ? 'stall' : 'recover', position: Math.round(this.currentPosition(now) * 10) / 10 });
          if (this.syncEvents.length > 120) this.syncEvents.splice(0, this.syncEvents.length - 120);
        }
        const correction = st.correction || {};
        if (!client.metrics) client.metrics = { corrections: [], lastCorrection: '' };
        const correctionType = ['seek', 'nudge', 'rate', 'frame', 'schedule'].includes(correction.type) ? correction.type : '';
        const correctionKey = correctionType && `${Number(correction.id) || 0}:${correctionType}:${Number(correction.at) || 0}`;
        if (correctionKey && correctionKey !== client.metrics.lastCorrection) {
          client.metrics.lastCorrection = correctionKey;
          client.metrics.corrections.push({ at: now, type: correctionType, drift: clamp(correction.drift, -60000, 60000), value: clamp(correction.value, -86400, 86400) });
          if (client.metrics.corrections.length > 12) client.metrics.corrections.shift();
        }
        this.checkWait();
        return;
      }
      case 'chat': {
        if (!isHost && !client.perms.chat) return this.send(client.ws, { type: 'error', code: 'no-permission', perm: 'chat' });
        const text = String(msg.text || '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, 500);
        if (!text) return;
        const m = { id: randKey(8), from: client.id, name: client.name, host: isHost, text, ts: Date.now(),
          movieId: this.movie?.id || null, position: this.movie ? Math.round(this.currentPosition() * 10) / 10 : null };
        this.pushChat(m);
        this.broadcast({ type: 'chat', message: m });
        return;
      }
      case 'react': {
        if (!isHost && !client.perms.react) return;
        if (!REACTIONS.includes(msg.emoji)) return;
        const now = Date.now();
        client.lastReact = client.lastReact.filter(t => now - t < 3000);
        if (client.lastReact.length >= 8) return;
        client.lastReact.push(now);
        const at = now + (this.state.playing ? 350 : 0);
        this.broadcast({ type: 'react', id: randKey(8), emoji: msg.emoji, from: client.id, name: client.name,
          movieId: this.movie?.id || null, position: this.movie ? Math.round(this.currentPosition(at) * 10) / 10 : null, at });
        return;
      }
      case 'media': {
        const cam = !!msg.cam, mic = !!msg.mic;
        if ((cam || mic) && !isHost && !client.perms.camera) {
          this.send(client.ws, { type: 'force-media-off' });
          client.media = { cam: false, mic: false };
        } else client.media = { cam, mic };
        this.broadcast({ type: 'peer-media', id: client.id, media: client.media });
        this.broadcastPeople(true);
        return;
      }
      case 'rtc': {
        const target = this.clients.get(msg.to);
        if (!target || !target.admitted) return;
        this.send(target.ws, { type: 'rtc', from: client.id, data: msg.data });
        return;
      }
      case 'rename': {
        const name = cleanName(msg.name);
        if (!name || name === client.name) return;
        const old = client.name;
        client.name = name;
        const mem = this.memory.get(client.id); if (mem) mem.name = name;
        this.system(`${old} is now ${name}`);
        this.broadcast({ type: 'peer-rename', id: client.id, name });
        this.broadcastPeople(true);
        return;
      }
      case 'request-control': {
        if (client.perms.playback) return;
        const now = Date.now();
        if (client.lastRequest && now - client.lastRequest < 15000) return;
        client.lastRequest = now;
        this.broadcastHosts({ type: 'toast', kind: 'request', text: `${client.name} is asking for playback control`, clientId: client.id });
        return;
      }
      default:
    }
    // ---------- every admitted member may pick what the room watches ----------
    if (this.canChoose(client)) {
      switch (msg.type) {
        case 'bookmark': {
          if (!this.movie) return;
          if (msg.action === 'remove') {
            const mark = this.bookmarks.find(x => x.id === msg.id);
            if (mark && (isHost || mark.from === client.id)) this.bookmarks = this.bookmarks.filter(x => x !== mark);
          } else {
            const label = String(msg.label || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 80);
            const position = Math.round(this.currentPosition() * 10) / 10;
            this.bookmarks.push({ id: randKey(8), movieId: this.movie.id, position, label: label || `Scene at ${Math.floor(position / 60)}:${String(Math.floor(position % 60)).padStart(2, '0')}`, from: client.id, name: client.name, ts: Date.now() });
            if (this.bookmarks.length > 40) this.bookmarks.shift();
          }
          this.broadcast({ type: 'bookmarks', bookmarks: this.bookmarks });
          return;
        }
        case 'select-movie': return this.selectMovie(client, msg.id);
        case 'select-url': return this.selectUrl(client, msg.url, !!msg.inTabs, { browsing: !!msg.browsing, follow: !!msg.follow, advanceFrom: msg.advanceFrom, custom: !!msg.custom, strict: msg.strict !== false, title: msg.title, duration: msg.duration, position: msg.position, playing: !!msg.playing });
        case 'select-anime': return this.selectAnime(client, msg);
        case 'movie-meta': return this.movieMeta(client, msg);
        case 'lib-list': if (!isHost) this.send(client.ws, { type: 'library', library: this.guestLibrary() }); return;
        case 'lib-prepare': {
          if (isHost) return; // the host uses its own page's controls
          const id = String(msg.id || '');
          try {
            this.library.prepare(id, msg.opts && typeof msg.opts === 'object' ? msg.opts : {});
            this.jobOwner.set(id, client.id);
            const it = this.library.items.get(id);
            this.broadcastHosts({ type: 'toast', kind: 'info', timeout: 5000, text: `${client.name} is preparing "${it ? it.title : 'a movie'}"` });
          } catch (e) { this.send(client.ws, { type: 'toast', kind: 'error', text: e.message }); }
          return;
        }
        case 'lib-cancel': {
          if (isHost) return;
          const id = String(msg.id || '');
          if (this.jobOwner.get(id) !== client.id) return this.send(client.ws, { type: 'toast', kind: 'error', text: 'Only the host or whoever started it can stop this.' });
          this.library.cancel(id);
          return;
        }
        case 'lib-probe': if (!isHost && this.library.items.get(String(msg.id || ''))) this.library.probe(String(msg.id)).catch(() => {}); return;
        case 'yt-search': {
          if (isHost || !this.ytSearch) return;
          // at most one search a second per person; a quicker one waits its turn (only the latest)
          const q = String(msg.q || '').slice(0, 150);
          const run = () => {
            client.ytTimer = null; client.lastYt = Date.now();
            this.ytSearch(q).then(results => this.send(client.ws, { type: 'yt-results', q, results }))
              .catch(e => this.send(client.ws, { type: 'yt-results', q, error: `Couldn't search YouTube right now (${e.message}). You can still paste a video link.` }));
          };
          clearTimeout(client.ytTimer);
          const wait = client.lastYt ? 1000 - (Date.now() - client.lastYt) : 0;
          if (wait > 0) client.ytTimer = setTimeout(run, wait); else run();
          return;
        }
        case 'anime-search': {
          if (isHost || !this.animeSearch) return;
          const q = String(msg.q || '').slice(0, 150);
          const run = () => {
            client.animeTimer = null; client.lastAnime = Date.now();
            this.animeSearch(q).then(results => this.send(client.ws, { type: 'anime-results', q, results }))
              .catch(e => this.send(client.ws, { type: 'anime-results', q, error: `Couldn't search anime right now (${e.message}).` }));
          };
          clearTimeout(client.animeTimer);
          const wait = client.lastAnime ? 1000 - (Date.now() - client.lastAnime) : 0;
          if (wait > 0) client.animeTimer = setTimeout(run, wait); else run();
          return;
        }
        default:
      }
    }
    if (!isHost) return;
    // ---------- host-only ----------
    switch (msg.type) {
      case 'set-perm': {
        const target = this.clients.get(msg.clientId);
        const mem = this.memory.get(msg.clientId);
        if (!PERMS.includes(msg.perm) || !mem || (target && target.role === 'host')) return;
        const perms = { ...(target ? target.perms : mem.perms), [msg.perm]: !!msg.value };
        mem.perms = perms;
        if (target) {
          target.perms = perms;
          this.send(target.ws, { type: 'perms', perms, changed: msg.perm, value: !!msg.value });
          if (msg.perm === 'camera' && !msg.value && (target.media.cam || target.media.mic)) {
            this.send(target.ws, { type: 'force-media-off' });
            target.media = { cam: false, mic: false };
            this.broadcast({ type: 'peer-media', id: target.id, media: target.media });
          }
        }
        this.broadcastPeople(true);
        return;
      }
      case 'set-all-perm': {
        if (!PERMS.includes(msg.perm)) return;
        for (const c of this.clients.values()) if (c.role !== 'host') this.onMessage(client, { type: 'set-perm', clientId: c.id, perm: msg.perm, value: msg.value });
        return;
      }
      case 'settings': {
        const s = msg.settings || {};
        if ('autoWait' in s) this.settings.autoWait = !!s.autoWait;
        if ('requireApproval' in s) this.settings.requireApproval = !!s.requireApproval;
        if ('locked' in s) this.settings.locked = !!s.locked;
        if ('maxGuests' in s) this.settings.maxGuests = Math.max(1, Math.min(20, Number(s.maxGuests) || 8));
        if (s.defaults) for (const p of PERMS) if (p in s.defaults) this.settings.defaults[p] = !!s.defaults[p];
        this.config.room = { autoWait: this.settings.autoWait, requireApproval: this.settings.requireApproval, maxGuests: this.settings.maxGuests, defaults: this.settings.defaults };
        this.save();
        this.broadcastSettings();
        return;
      }
      case 'admit': {
        const t = this.clients.get(msg.clientId);
        if (t && !t.admitted) this.admit(t);
        return;
      }
      case 'deny':
      case 'kick': {
        const t = this.clients.get(msg.clientId);
        if (!t || t.role === 'host') return;
        if (msg.type === 'kick') this.banned.add(t.id);
        this.memory.delete(t.id);
        this.send(t.ws, { type: 'denied', reason: msg.type === 'kick' ? 'removed' : 'declined' });
        try { t.ws.close(4003, msg.type); } catch {}
        this.leave(t, true);
        if (msg.type === 'kick') this.system(`${t.name} was removed by the host`);
        return;
      }
      case 'rotate-link': {
        this.roomKey = randKey(24);
        this.config.roomKey = this.roomKey;
        this.save();
        this.banned.clear();
        for (const c of [...this.clients.values()]) {
          if (c.role === 'host') continue;
          this.send(c.ws, { type: 'denied', reason: 'link-changed' });
          try { c.ws.close(4003, 'link-changed'); } catch {}
          this.leave(c, true);
          this.memory.delete(c.id);
        }
        this.broadcastHosts({ type: 'link-changed' });
        return;
      }
      default:
    }
  }

  shutdown() { clearInterval(this.timer); }
}

module.exports = { Room, randKey, PERMS, REACTIONS };
