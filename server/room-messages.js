'use strict';
// Room.onMessage: one case per message type a browser can send. `this` is the Room.
const crypto = require('crypto');
const services = require('./services');
const { randKey, PERMS, REACTIONS, START_DELAY_MS, cleanName } = require('./room');

function onMessage(client, msg) {
  const isHost = client.role === 'host';
  if (!client.admitted) return;
  switch (msg.type) {
    case 'playback-import': {
      if (!isHost || !this.animeHistory || !Array.isArray(msg.entries)) return;
      const entries = msg.entries.slice(0, 500).flatMap(value => {
        const info = services.identify(value?.url);
        if (!info || info.service !== value.service || value.ad || value.preview) return [];
        return [{ id: 'u' + crypto.createHash('sha1').update(info.url).digest('hex').slice(0, 11), kind: 'service',
          service: info.service, url: info.url, title: value.title, poster: value.poster, position: value.position, duration: value.duration,
          updatedAt: Math.min(Date.now(), Number(value.lastWatched) || 0) }];
      });
      if (this.animeHistory.importPlayback(entries)) { this.sendPlaybackHistory(); this.fillNetflixCards(); }
      return;
    }
    case 'playback-progress': {
      const st = msg.status || {}, movie = this.movie;
      if (!isHost || !this.animeHistory || !movie || movie.kind === 'anime' || movie.browsing || st.movieId !== movie.id || st.seq !== this.state.seq ||
        !st.loaded || !st.ready || st.seeking || st.error || st.blocked || st.ad || st.preview) return;
      if (movie.kind === 'service' && services.identify(msg.url)?.url !== movie.url) return;
      if (this.animeHistory.recordPlayback(movie, st.position, st.duration)) this.sendPlaybackHistory();
      if (movie.service === 'netflix') this.fillNetflixCards(movie.id);
      if (msg.flush) this.animeHistory.flush();
      return;
    }
    case 'playback-dismiss': {
      if (isHost && this.animeHistory?.dismissPlayback(msg.id)) this.sendPlaybackHistory();
      return;
    }
    case 'select-playback': {
      if (!this.canChoose(client)) return;
      const saved = this.animeHistory?.playbackEntries.get(msg.id);
      if (!saved) return;
      if (saved.kind === 'file') this.selectMovie(client, saved.id);
      else if (saved.kind === 'catalog') this.selectCatalog(client, { ref: saved.catalogRef, language: saved.language, title: saved.catalogTitle });
      else this.selectUrl(client, saved.url, saved.kind === 'service', { title: saved.title, duration: saved.duration, position: saved.position, playing: true });
      if (this.movie?.id === saved.id) this.setState({ position: saved.position, playing: true, anchor: Date.now() + START_DELAY_MS }, { by: client.name, action: 'resume' });
      return;
    }
    case 'notification': {
      if (!/^[A-Za-z0-9_-]{6,64}$/.test(msg.id || '')) return;
      const owner = this.notificationOwner(client);
      if (this.notifications.some(entry => entry.owner === owner && entry.id === msg.id)) return;
      const text = String(msg.text || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 500);
      if (!text) return;
      const entry = { id: msg.id, ts: Date.now(), text, kind: ['error', 'knock', 'request', 'info'].includes(msg.kind) ? msg.kind : 'info' };
      this.notifications.push({ ...entry, owner });
      if (this.notifications.length > 1000) this.notifications.shift();
      this.send(client.ws, { type: 'notification', notification: entry });
      return;
    }
    case 'notifications-clear':
      if (isHost) { this.notifications = []; this.broadcast({ type: 'notifications-clear' }); }
      return;
    case 'anime-continue-dismiss': {
      if (isHost && this.animeHistory?.dismiss(msg.anilistId)) this.sendAnimeHistory();
      return;
    }
    case 'anime-history-mark': {
      if (isHost && this.animeHistory?.mark(msg.anilistId, msg.episode, msg.completed)) {
        if (!msg.completed && this.movie?.anilistId === msg.anilistId && this.movie?.episode === msg.episode) {
          this.setState({ playing: false, position: 0, anchor: Date.now(), waiting: false, waitingFor: [] }, { by: client.name, action: 'seek' });
        }
        this.sendAnimeHistory();
      }
      return;
    }
    case 'anime-progress': {
      const leader = this.animeLeader();
      if ((leader ? leader.id !== client.id : !isHost) || !this.animeHistory || this.movie?.kind !== 'anime') return;
      const st = msg.status || {};
      // Reject old-episode / pre-seek reports, including a new stream's initial 0:00 metadata.
      if (st.movieId !== this.movie.id || st.seq !== this.state.seq || !st.loaded || st.seeking || st.error
        || (!st.ready && !st.ended) || !Number.isFinite(st.position) || !Number.isFinite(st.duration) || st.duration <= 0) return;
      if (this.animeHistory.record(this.movie, st.position, st.duration, st.ended)) this.sendAnimeHistory();
      if (msg.flush) this.animeHistory.flush();
      return;
    }
    case 'anime-auto-skip': {
      if (!this.canControl(client) || typeof msg.enabled !== 'boolean') return;
      this.settings.animeAutoSkip = msg.enabled;
      this.config.room = { ...this.config.room, animeAutoSkip: msg.enabled, aiFeatures: this.settings.aiFeatures };
      this.save?.();
      this.broadcastSettings();
      return;
    }
    case 'cmd': return this.command(client, msg);
    case 'status': {
      const st = msg.status || {};
      if (isHost && this.movie?.kind === 'youtube' && st.movieId === this.movie.id && st.seq === this.state.seq &&
          st.loaded && st.ready && st.ended && !st.seeking && !st.ad && !st.blocked && !st.error &&
          Number.isFinite(st.duration) && st.duration > 0 && st.duration < 86400 && Number.isFinite(st.position) &&
          st.position >= st.duration - 1 && st.position <= st.duration + 1 &&
          (!this.movie.duration || Math.abs(this.movie.duration - st.duration) < 2) && (this.state.playing || this.state.waiting)) {
        this.movie.duration = st.duration;
        if (this.animeHistory?.recordPlayback(this.movie, st.duration, st.duration)) { this.animeHistory.flush(); this.sendPlaybackHistory(); }
        this.setState({ playing: false, position: st.duration, anchor: Date.now(), waiting: false, waitingFor: [] }, { action: 'ended' });
      }
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
        this.broadcastHosts({ type: 'toast', kind: 'error', text: `${client.name}'s browser could not play this copy. Prepare it again with “Start sooner for everyone” enabled.` });
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
    // Live captions, "catch me up" and highlights (live-captions.js, recap.js, highlights.js). Off unless the host starts them.
    case 'captions-start':
      if (!isHost || !this.settings.aiFeatures) return;
      if (this.liveCaptioner) this.liveCaptioner.start();
      else this.send(client.ws, { type: 'captions-status', ok: false, active: false, reason: 'unavailable' });
      return;
    case 'captions-stop': if (isHost) this.liveCaptioner?.stop(); return;
    case 'captions-sync':
      if (this.liveCaptioner) this.liveCaptioner.sync(client);
      else this.send(client.ws, { type: 'captions-status', ok: false, active: false, reason: 'unavailable' });
      this.highlights?.sync(client);
      return;
    case 'recap-request':
      if (!this.settings.aiFeatures) return this.send(client.ws, { type: 'recap', text: '', reason: 'unavailable' });
      if (this.recap) this.recap.request(client);
      else this.send(client.ws, { type: 'recap', text: '', reason: 'unavailable' });
      return;
    case 'highlights-generate':
      if (!isHost || !this.settings.aiFeatures) return;
      if (this.highlights) this.highlights.generate(client);
      else this.send(client.ws, { type: 'highlights', clips: [], reason: 'unavailable' });
      return;
    default:
  }
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
          const hours = Math.floor(position / 3600), minutes = Math.floor(position / 60) % 60;
          const time = `${hours ? `${hours}:${String(minutes).padStart(2, '0')}` : minutes}:${String(Math.floor(position % 60)).padStart(2, '0')}`;
          this.bookmarks.push({ id: randKey(8), movieId: this.movie.id, position, label: label || `Scene at ${time}`, from: client.id, name: client.name, ts: Date.now() });
          if (this.bookmarks.length > 40) this.bookmarks.shift();
        }
        this.broadcast({ type: 'bookmarks', bookmarks: this.bookmarks });
        return;
      }
      case 'select-movie': return this.selectMovie(client, msg.id);
      case 'select-url': return this.selectUrl(client, msg.url, !!msg.inTabs, { browsing: !!msg.browsing, follow: !!msg.follow, advanceFrom: msg.advanceFrom, custom: !!msg.custom, strict: msg.strict !== false, title: msg.title, launchTitle: msg.launchTitle, playbackRef: msg.playbackRef, duration: msg.duration, position: msg.position, playing: !!msg.playing });
      case 'select-anime': return this.limitedTask(client, 'anime-resolve', () => this.selectAnime(client, msg), { interval: 500 });
      case 'find-subtitles': return this.findSubtitles(client, msg);
      case 'select-catalog': return this.selectCatalog(client, msg);
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
          if (client.closed) return;
          this.limitedTask(client, 'yt-search', () => this.ytSearch(q, { mode: msg.mode, id: msg.id }).then(results => this.send(client.ws, { type: 'yt-results', q, results, request: msg.request }))
            .catch(e => this.send(client.ws, { type: 'yt-results', q, request: msg.request, error: `Couldn't search YouTube right now (${e.message}). You can still paste a video link.` })));
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
          if (client.closed) return;
          this.limitedTask(client, 'anime-search', () => this.animeSearch(q).then(results => this.send(client.ws, { type: 'anime-results', q, results }))
            .catch(e => this.send(client.ws, { type: 'anime-results', q, error: `Couldn't search anime right now (${e.message}).` })));
        };
        clearTimeout(client.animeTimer);
        const wait = client.lastAnime ? 1000 - (Date.now() - client.lastAnime) : 0;
        if (wait > 0) client.animeTimer = setTimeout(run, wait); else run();
        return;
      }
      case 'catalog-query': {
        if (isHost || !this.catalog) return;
        const requestId = String(msg.requestId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
        if (!requestId) return;
        const run = async () => {
          try {
            let result;
            if (msg.op === 'search') result = await this.catalog.search(String(msg.q || '').slice(0, 150));
            else if (msg.op === 'details') result = await this.catalog.details(String(msg.mediaType || ''), Number(msg.tmdbId));
            else if (msg.op === 'season') result = await this.catalog.season(Number(msg.tmdbId), Number(msg.season));
            else if (msg.op === 'providers') result = await this.catalog.providers(String(msg.mediaType || ''), Number(msg.tmdbId));
            else throw new Error('Unknown catalog request.');
            this.send(client.ws, { type: 'catalog-response', requestId, result });
          } catch (error) { this.send(client.ws, { type: 'catalog-response', requestId, error: error.message }); }
        };
        this.limitedTask(client, 'catalog-query', run);
        return;
      }
      default:
    }
  }
  if (!isHost) return;
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
      if ('aiFeatures' in s) {
        this.settings.aiFeatures = !!s.aiFeatures;
        if (!this.settings.aiFeatures) { this.liveCaptioner?.stop(); this.highlights?.stop(); }
      }
      if ('requireApproval' in s) this.settings.requireApproval = !!s.requireApproval;
      if ('locked' in s) this.settings.locked = !!s.locked;
      if ('maxGuests' in s) this.settings.maxGuests = Math.max(1, Math.min(20, Number(s.maxGuests) || 8));
      if (s.defaults) for (const p of PERMS) if (p in s.defaults) this.settings.defaults[p] = !!s.defaults[p];
      this.config.room = { autoWait: this.settings.autoWait, animeAutoSkip: this.settings.animeAutoSkip, aiFeatures: this.settings.aiFeatures, requireApproval: this.settings.requireApproval, maxGuests: this.settings.maxGuests, defaults: this.settings.defaults };
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
      for (const [id, mem] of this.memory) if (mem.role !== 'host') this.memory.delete(id);
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

module.exports = onMessage;
