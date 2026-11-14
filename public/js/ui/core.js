// Shared by every part of the page: small helpers, who this browser is, the room state and the active player.
import { playbackCapabilities } from '../capabilities.js';
import { PLATFORM } from '../platform.js';
import { trackPlayerWindow } from '../player-window.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
// Frequent room updates re-render whole lists; skipping identical markup keeps hover, focus, scroll and open menus.
const setHtml = (el, html) => { if (el._html !== html) el.innerHTML = el._html = html; };
const icon = (name, cls = '') => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
function fmtTime(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function fmtEta(s) { if (s == null) return ''; if (s < 60) return `${s}s left`; const m = Math.round(s / 60); return m < 60 ? `${m} min left` : `${Math.floor(m / 60)}h ${m % 60}m left`; }
function hue(str) { let h = 0; for (const c of String(str)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
const avatar = (name, cls = 'av') => `<span class="${cls}" style="background:hsl(${hue(name)} 70% 68%)">${esc((name || '?').trim().charAt(0).toUpperCase())}</span>`;
function randId() { const a = new Uint8Array(12); crypto.getRandomValues(a); return [...a].map(b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join(''); }
function resLabel(w, h) { if (!w) return ''; if (w >= 3200 || h >= 1800) return '4K'; if (w >= 1800 || h >= 1000) return '1080p'; if (w >= 1200 || h >= 700) return '720p'; return `${h}p`; }
function codecLabel(c) { return ({ hevc: 'HEVC', h264: 'H.264', av1: 'AV1', vp9: 'VP9', mpeg2video: 'MPEG-2', vc1: 'VC-1' })[c] || (c || '').toUpperCase(); }

const app = $('#app');
const parts = location.pathname.split('/').filter(Boolean);
const mode = parts[0] === 'host' ? 'host' : parts[0] === 'join' ? 'guest' : null;
const key = parts[1] || '';
const isHost = mode === 'host';
if (isHost) app.classList.add('is-host');
if (isHost) trackPlayerWindow(key, { id: randId() });

const isTheater = new URLSearchParams(location.search).get('theater') === '1' && window.top !== window;
const handoff = new URLSearchParams(location.hash.slice(1));
if (location.hash) history.replaceState(null, '', location.pathname + location.search);
if (isTheater) app.classList.add('theater');
if (isTheater && /^[a-z0-9]{8,40}$/.test(handoff.get('wpcid') || '')) store.set(isHost ? 'wp.hostId' : 'wp.clientId', handoff.get('wpcid'));
if (isTheater && handoff.get('wpname')) store.set(isHost ? 'wp.hostName' : 'wp.name', handoff.get('wpname').slice(0, 32));
let clientId = store.get(isHost ? 'wp.hostId' : 'wp.clientId', null);
if (!clientId) { clientId = randId(); store.set(isHost ? 'wp.hostId' : 'wp.clientId', clientId); }

const S = {
  chatLog: [],
  me: null, perms: {}, people: [], totalMbps: 0, movie: null, state: null, settings: {}, reactions: [],
  observatory: null, bookmarks: [], animeHistory: [], animeContinueHidden: [], playbackHistory: [],
  peers: new Map(), remoteStreams: new Map(), cam: false, mic: false, tab: 'chat', unread: 0,
  library: null, info: null, prepOpen: new Set(), prepOpts: new Map(), lastSender: null, lastSenderTs: 0,
  name: '',
};

const video = $('#video');
const PLAYBACK = playbackCapabilities(video, globalThis, PLATFORM);
const stage = $('#stage');
// The media everything talks to: the <video> for your files, or a YouTube / streaming-tab adapter.
let M = video;
let ytMedia = null, remote = null;
const room = $('#room');
let conn = null, player = null, mesh = null;
// Importers cannot assign another module's bindings, so the entry script swaps these through `set`.
const set = { M: v => { M = v; }, conn: v => { conn = v; }, mesh: v => { mesh = v; }, ytMedia: v => { ytMedia = v; }, remote: v => { remote = v; }, player: v => { player = v; } };

function rememberClientId(you) {
  if (you?.id && you.id !== clientId) { clientId = you.id; store.set(isHost ? 'wp.hostId' : 'wp.clientId', clientId); }
}

const kindOf = movie => (movie ? movie.kind || 'file' : '');
// Plays in the shared <video> as a direct file or native HLS.
const isNativeMovie = movie => { const k = kindOf(movie); return k === 'file' || k === 'anime' || k === 'catalog'; };

function mediaFor(movie) {
  const k = kindOf(movie);
  return k === 'youtube' ? ytMedia : k === 'service' ? remote : video;
}

const isCustom = () => !!(S.movie && S.movie.service === 'custom');
const canControl = () => isHost || (!!S.perms.playback && !isCustom());

function localPos() { return M.isAdapter && Number.isFinite(M.seekingTarget) ? M.seekingTarget : M.readyState >= 1 ? M.currentTime : player.expected(); }

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key, ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export { $, $$, M, PLAYBACK, S, api, app, avatar, canControl, clientId, codecLabel, conn, esc, fmtEta, fmtTime, hue, icon, isCustom, isHost, isNativeMovie, isTheater, key, kindOf, localPos, mediaFor, mesh, mode, player, randId, rememberClientId, remote, resLabel, room, set, setHtml, stage, store, video, ytMedia };
