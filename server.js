// Tiny zero-dependency server: static files + WebRTC signaling over HTTP long-polling.
// Long-polling (not EventSource) so every request can carry ngrok's skip-warning header.
// Each room has at most one host (laptop) and one viewer (iPhone).
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleRedisSignaling, redisConfigured } from './signal-redis.js';

// Running as the public site (Vercel): no macOS helper, and rooms must live in Redis because Vercel may
// run several short-lived copies of this server. On a Mac (npm start) rooms stay in memory.
const HOSTED = Boolean(process.env.VERCEL);
if (HOSTED && !redisConfigured) {
  console.warn('Hosted without Redis: rooms live in memory and will randomly disappear. Add Upstash Redis (KV_REST_API_URL / KV_REST_API_TOKEN).');
}

// If the port is taken by another app, the next free port is used and printed.
const PREFERRED_PORT = Number(process.env.PORT) || 3001;
let PORT = PREFERRED_PORT;
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const ROUTES = { '/': 'host.html', '/view': 'view.html', '/zone': 'zone.html' };
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};
const NATIVE_DIR = fileURLToPath(new URL('./native/', import.meta.url));
const HELPER_SRC = join(NATIVE_DIR, 'phone-display.swift');
const HELPER_HEADER = join(NATIVE_DIR, 'CGVirtualDisplay.h');
// The desktop app ships a prebuilt helper (users have no Swift compiler); otherwise compile on first use.
const PREBUILT_HELPER = process.env.PHONE_SCREEN_HELPER || '';
const HELPER_BIN = PREBUILT_HELPER || join(NATIVE_DIR, '.build', 'phone-display');
const OTHER = { host: 'viewer', viewer: 'host' };
const POLL_HOLD_MS = 25_000;
const PEER_TIMEOUT_MS = 40_000;
const EMPTY_ROOM_TTL_MS = 2 * 60_000;   // a room with nobody in it is removed after this
const JOIN_FAILS_PER_MINUTE = 20;       // wrong room codes allowed per client per minute

// Optional TURN relay for when the phone and laptop can't reach each other directly (e.g. 4G).
// TURN_URLS is comma-separated, e.g. "turn:global.relay.metered.ca:80,turns:global.relay.metered.ca:443".
const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ...(process.env.TURN_URLS
    ? [{
        urls: process.env.TURN_URLS.split(',').map((u) => u.trim()),
        username: process.env.TURN_USERNAME,
        credential: process.env.TURN_CREDENTIAL,
      }]
    : []),
];

/**
 * @typedef {{ id: string, queue: object[], waiter: http.ServerResponse|null, holdTimer: any, lastSeen: number }} Peer
 * @typedef {{ key: string, host: Peer|null, viewer: Peer|null, pending: Map<string, Peer>, emptySince: number|null }} Room
 * @type {Map<string, Room>}
 *
 * Access: every room has a secret key (in the laptop's QR code and room link). The host must present it.
 * A phone that presents it joins directly; a phone that only knows the 4-digit code (typed, or "join latest")
 * waits until the laptop clicks Allow.
 */
const rooms = new Map();
let latestRoom = null;

// Free 4-digit code, or null when (absurdly) all 9000 are taken.
function newCode() {
  for (let i = 0; i < 50; i++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    if (!rooms.has(code)) return code;
  }
  for (let n = 1000; n <= 9999; n++) if (!rooms.has(String(n))) return String(n);
  return null;
}

const newKey = () => randomBytes(16).toString('base64url');

function keyMatches(entry, key) {
  if (!key || !entry) return false;
  const a = Buffer.from(String(key)), b = Buffer.from(entry.key);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Slow down guessing room codes: count failed joins per client address.
const joinFails = new Map(); // address -> { count, since }
function tooManyFails(req) {
  const f = joinFails.get(req.socket.remoteAddress);
  return Boolean(f && Date.now() - f.since < 60_000 && f.count >= JOIN_FAILS_PER_MINUTE);
}
function countFail(req) {
  const addr = req.socket.remoteAddress;
  const f = joinFails.get(addr);
  if (!f || Date.now() - f.since >= 60_000) joinFails.set(addr, { count: 1, since: Date.now() });
  else f.count++;
}

// Wi-Fi/Ethernet (en*) first: VPN (utun*), bridges and VM adapters usually aren't reachable from the phone.
function lanIps() {
  const rank = (name) => (/^en\d/.test(name) ? 0 : /^(utun|ipsec|ppp|tun|tap|bridge|vmnet|vbox|docker|awdl|llw)/.test(name) ? 2 : 1);
  return Object.entries(networkInterfaces())
    .flatMap(([name, addrs]) => (addrs ?? []).map((a) => ({ name, ...a })))
    .filter((i) => i.family === 'IPv4' && !i.internal)
    .sort((a, b) => rank(a.name) - rank(b.name))
    .map((i) => i.address);
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function flush(peer) {
  if (!peer?.waiter || !peer.queue.length) return;
  clearTimeout(peer.holdTimer);
  json(peer.waiter, 200, { messages: peer.queue.splice(0) });
  peer.waiter = null;
}

function deliver(peer, msg) {
  if (!peer) return;
  peer.queue.push(msg);
  flush(peer);
}

function dropPeer(peer) {
  clearTimeout(peer.holdTimer);
  if (peer.waiter) json(peer.waiter, 410, { error: 'left' });
  peer.waiter = null;
}

function markEmpty(entry) {
  entry.emptySince = !entry.host && !entry.viewer && !entry.pending.size ? Date.now() : null;
}

// A peer really goes away (closed page, timed out). The room itself stays until it has been empty a while,
// so a laptop that slept can rejoin its room.
function leave(room, role, entry = rooms.get(room)) {
  const peer = entry?.[role];
  if (!peer) return;
  dropPeer(peer);
  entry[role] = null;
  deliver(entry[OTHER[role]], { type: 'peer-left', role });
  // Don't leave the cursor stranded on a screen nobody is watching.
  helperSend({ t: 'home' });
  markEmpty(entry);
}

const newPeer = () => ({ id: randomUUID(), queue: [], waiter: null, holdTimer: null, lastSeen: Date.now() });

// Keep a peer that was turned away reachable for a moment, so its next poll still gets the message
// (it would otherwise rejoin, and two phones would keep kicking each other out).
function retire(entry, peer, msg) {
  peer.retired = true;
  entry.pending.set(peer.id, peer);
  deliver(peer, msg);
  setTimeout(() => {
    if (entry.pending.get(peer.id) !== peer) return;
    entry.pending.delete(peer.id);
    dropPeer(peer);
    markEmpty(entry);
  }, 10_000);
}

// Put a peer into its role. A page refresh replaces its own old session quietly (no "left", no cursor jump);
// a phone replaced by another device is told so and stops.
function seat(entry, role, peer) {
  if (entry[role] && role === 'viewer') retire(entry, entry[role], { type: 'replaced' });
  else if (entry[role]) dropPeer(entry[role]);
  entry[role] = peer;
  entry.emptySince = null;
  const other = entry[OTHER[role]];
  deliver(other, { type: 'peer-joined', role });
  if (other) peer.queue.push({ type: 'peer-joined', role: OTHER[role] });
  // A laptop that (re)joins hears about phones still waiting for its OK.
  if (role === 'host') {
    for (const [pid, p] of entry.pending) if (!p.retired) peer.queue.push({ type: 'viewer-request', id: pid });
  }
}

function joinRoom(req, res, room, role, key) {
  const entry = rooms.get(room);
  if (!OTHER[role]) return json(res, 400, { error: 'bad role' });
  if (tooManyFails(req)) return json(res, 429, { error: 'too many tries, wait a minute' });
  if (!entry) {
    countFail(req);
    return json(res, 404, { error: 'room not found' });
  }
  const trusted = keyMatches(entry, key);
  if (role === 'host' && !trusted) {
    countFail(req);
    return json(res, 403, { error: 'not this room\'s laptop' });
  }
  const peer = newPeer();
  if (role === 'host' || trusted) {
    seat(entry, role, peer);
    return json(res, 200, { id: peer.id });
  }
  // Code only: the laptop has to allow this phone first.
  entry.pending.set(peer.id, peer);
  entry.emptySince = null;
  peer.queue.push({ type: 'waiting-approval' });
  deliver(entry.host, { type: 'viewer-request', id: peer.id });
  json(res, 200, { id: peer.id, pending: true });
}

function approve(entry, viewerId, allow) {
  const peer = entry.pending.get(viewerId);
  if (!peer || peer.retired) return false;
  entry.pending.delete(viewerId);
  if (allow) seat(entry, 'viewer', peer);
  else retire(entry, peer, { type: 'denied' });
  return true;
}

function findPeer(room, role, id) {
  const entry = rooms.get(room);
  const peer = entry?.[role];
  return peer && peer.id === id ? peer : null;
}

// Pending phones may poll (to hear "allowed"/"denied") but not send anything.
function findPeerOrPending(room, role, id) {
  return findPeer(room, role, id) ?? (role === 'viewer' ? rooms.get(room)?.pending.get(id) ?? null : null);
}

function poll(req, res, peer) {
  peer.lastSeen = Date.now();
  if (peer.waiter) json(peer.waiter, 200, { messages: [] });
  clearTimeout(peer.holdTimer);
  peer.waiter = res;
  if (peer.queue.length) return flush(peer);
  peer.holdTimer = setTimeout(() => {
    if (peer.waiter !== res) return;
    peer.waiter = null;
    peer.lastSeen = Date.now();
    json(res, 200, { messages: [] });
  }, POLL_HOLD_MS);
  res.on('close', () => {
    if (peer.waiter === res) {
      clearTimeout(peer.holdTimer);
      peer.waiter = null;
      peer.lastSeen = Date.now();
    }
  });
}

// ---- Virtual iPhone display + input injection (macOS helper) ----
// Only the laptop page itself may drive these. Not LAN clients, not ngrok (which adds X-Forwarded-For),
// and not other websites open in the laptop's browser: those can send requests to localhost too, so the
// request must also come from this app's own page (Origin / Sec-Fetch-Site), else it could type on the Mac.
function isLaptop(req) {
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const localHost = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host ?? '');
  if (!loopback || !localHost || req.headers['x-forwarded-for']) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) return false;
  return true;
}

let helper = null; // { proc, info, cursorOnPhone }
const cursorStreams = new Set(); // laptop pages receiving live cursor positions
let lastCursorLine = 'off';

// Cursor positions as "x,y" (0..10000 within the iPhone screen) or "off", one per line.
// Direct cursor stream for phones (Server-Sent Events): helper → server → iPhone, skipping the laptop's
// Chrome page, which runs in the background while you work and can be slow to pass positions on.
// Positions are only sent while the laptop page says the iPhone screen is what's being shared.
const phoneCursorStreams = new Set();
let cursorVisible = false;

function phoneCursorEvent(line) {
  return cursorVisible && line !== 'off' ? `data: ${line},${Date.now()}\n\n` : 'data: off\n\n';
}

function broadcastCursor(line) {
  lastCursorLine = line;
  for (const res of cursorStreams) res.write(`${line}\n`);
  const event = phoneCursorEvent(line);
  for (const res of phoneCursorStreams) res.write(event);
}

function openPhoneCursorStream(req, res) {
  req.socket.setNoDelay(true);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 1000\n${phoneCursorEvent(lastCursorLine)}`);
  phoneCursorStreams.add(res);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
  res.on('close', () => {
    clearInterval(keepAlive);
    phoneCursorStreams.delete(res);
  });
}

function openCursorStream(req, res) {
  if (!isLaptop(req)) return json(res, 403, { error: 'laptop only' });
  req.socket.setNoDelay(true);
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.write(`${lastCursorLine}\n`);
  if (helper?.cursorImage) res.write(`${helper.cursorImage}\n`);
  cursorStreams.add(res);
  res.on('close', () => cursorStreams.delete(res));
}

function helperSend(cmd) {
  if (helper?.info) helper.proc.stdin.write(`${JSON.stringify(cmd)}\n`);
}

async function buildHelper() {
  if (PREBUILT_HELPER) return;
  const [src, header, bin] = await Promise.all([stat(HELPER_SRC), stat(HELPER_HEADER), stat(HELPER_BIN).catch(() => null)]);
  if (bin && bin.mtimeMs > Math.max(src.mtimeMs, header.mtimeMs)) return;
  await mkdir(join(NATIVE_DIR, '.build'), { recursive: true });
  console.log('Compiling native helper (first run takes ~20s)…');
  await new Promise((resolve, reject) =>
    execFile('swiftc', ['-O', '-import-objc-header', HELPER_HEADER, HELPER_SRC, '-o', HELPER_BIN], (err, _out, stderr) =>
      err ? reject(new Error(`swiftc failed: ${stderr || err.message}`)) : resolve()));
}

function stopHelper() {
  cursorVisible = false;
  broadcastCursor('off');
  if (!helper) return;
  helper.proc.stdin.end();
  helper.proc.kill();
  helper = null;
}

// Jump shortcut, e.g. "cmd+P": modifiers then one key (letter, digit, F1–F12, Space), at least one of cmd/ctrl/alt.
const HOTKEY_RE = /^(?=.*\b(cmd|ctrl|alt)\+)((cmd|ctrl|alt|shift)\+){1,4}([A-Z0-9]|F([1-9]|1[0-2])|Space)$/;
// jump: back and forth between laptop and iPhone screen. center: cursor to the middle of the iPhone screen.
const DEFAULT_HOTKEYS = { jump: 'cmd+P', center: 'cmd+O' };

async function startHelper(width, height, position, hotkeys) {
  stopHelper();
  await buildHelper();
  const args = [String(width), String(height), position, hotkeys.jump, hotkeys.center];
  const proc = spawn(HELPER_BIN, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  const current = { proc, info: null, cursorOnPhone: false, hotkeys: {}, hotkeyWaiters: [] };
  helper = current;
  proc.stdin.on('error', () => {});
  proc.on('exit', () => {
    if (helper === current) helper = null;
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('helper did not start in time')), 15000);
    createInterface({ input: proc.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.type === 'pos') return broadcastCursor(msg.off ? 'off' : `${msg.x},${msg.y}`);
      if (msg.type === 'cursorimg') {
        current.cursorImage = `img ${JSON.stringify({ png: msg.png, w: msg.w, h: msg.h, hx: msg.hx, hy: msg.hy })}`;
        for (const res of cursorStreams) res.write(`${current.cursorImage}\n`);
        return;
      }
      if (msg.type === 'hotkey') {
        if (msg.ok) current.hotkeys[msg.name] = { spec: msg.spec, label: msg.label };
        current.hotkeyWaiters = current.hotkeyWaiters.filter((w) =>
          w.name === msg.name && w.spec === msg.spec ? (w.resolve(msg), false) : true);
        return;
      }
      if (msg.type === 'cursor') current.cursorOnPhone = msg.onPhone;
      else if (msg.type === 'warning') console.warn(`helper: ${msg.warning}`);
      else if (msg.type === 'ready') {
        current.info = msg;
        clearTimeout(timer);
        resolve(msg);
      } else if (msg.type === 'error') {
        clearTimeout(timer);
        reject(new Error(msg.error));
      }
    });
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`helper exited (${code})`)); });
  });
}

async function handleDisplay(req, res, url) {
  if (!isLaptop(req)) return json(res, 403, { error: 'open the laptop page at http://localhost to use this' });
  if (process.platform !== 'darwin') return json(res, 501, { error: 'virtual display needs macOS' });
  if (req.method === 'GET') {
    return json(res, 200, {
      active: Boolean(helper?.info), ...helper?.info, cursorOnPhone: Boolean(helper?.cursorOnPhone), hotkeys: helper?.hotkeys ?? {},
    });
  }
  if (url.searchParams.get('action') === 'hotkey') {
    const spec = url.searchParams.get('spec') ?? '';
    const name = url.searchParams.get('name') ?? 'jump';
    if (!Object.hasOwn(DEFAULT_HOTKEYS, name)) return json(res, 400, { ok: false, error: 'unknown shortcut' });
    if (!HOTKEY_RE.test(spec)) return json(res, 400, { ok: false, error: 'not a valid shortcut' });
    if (!helper?.info) return json(res, 200, { ok: true, name, spec, pending: true }); // used when the screen is added
    const answer = await new Promise((resolve) => {
      helper.hotkeyWaiters.push({ name, spec, resolve });
      helperSend({ t: 'hotkey', name, spec });
      setTimeout(() => resolve({ ok: false, error: 'the helper did not answer' }), 2000);
    });
    return json(res, 200, answer);
  }
  if (url.searchParams.get('action') === 'cursor-visible') {
    cursorVisible = url.searchParams.get('on') === '1';
    broadcastCursor(lastCursorLine);
    return json(res, 200, { ok: true, cursorVisible });
  }
  if (url.searchParams.get('action') === 'home') {
    helperSend({ t: 'home' });
    return json(res, 200, { ok: true });
  }
  if (req.method === 'DELETE') {
    await displayQueue;
    stopHelper();
    return json(res, 200, { active: false });
  }
  // Landscape or portrait; each side 300–2560 points.
  const side = (name, fallback) => Math.round(Math.min(Math.max(Number(url.searchParams.get(name)) || fallback, 300), 2560) / 2) * 2;
  const width = side('width', 1280);
  const height = side('height', 590);
  const position = ['right', 'left', 'above'].includes(url.searchParams.get('position')) ? url.searchParams.get('position') : 'right';
  const hotkeys = {};
  for (const [name, fallback] of Object.entries(DEFAULT_HOTKEYS)) {
    const requested = url.searchParams.get(name === 'jump' ? 'hotkey' : `hotkey_${name}`);
    hotkeys[name] = requested && HOTKEY_RE.test(requested) ? requested : fallback;
  }
  // One display change at a time: overlapping requests (two tabs, a retry) would kill each other's helper.
  const run = displayQueue.then(async () => {
    try {
      const info = await startHelper(width, height, position, hotkeys);
      return { status: 200, body: { active: true, position, ...info, hotkeys: helper?.hotkeys ?? {} } };
    } catch (err) {
      stopHelper(); // only ever this request's helper: nothing else runs while we hold the queue
      return { status: 500, body: { error: err.message } };
    }
  });
  displayQueue = run.catch(() => {});
  const { status, body } = await run;
  return json(res, status, body);
}
let displayQueue = Promise.resolve();

const INPUT_TYPES = new Set(['click', 'rightclick', 'down', 'drag', 'up', 'move', 'scroll', 'key', 'text']);

async function handleInput(req, res) {
  if (!isLaptop(req)) return json(res, 403, { error: 'input only accepted from the laptop page on localhost' });
  if (!helper?.info) return json(res, 409, { error: 'no virtual display' });
  let events;
  try {
    ({ events } = JSON.parse(await readBody(req)) ?? {});
  } catch {
    return json(res, 400, { error: 'body must be JSON' });
  }
  for (const e of Array.isArray(events) ? events : []) {
    if (INPUT_TYPES.has(e?.t)) helperSend(e);
  }
  json(res, 200, { ok: true });
}

async function serveStatic(res, pathname) {
  const file = ROUTES[pathname] ?? pathname.slice(1);
  const full = normalize(join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR) || full.endsWith(sep)) return json(res, 404, { error: 'not found' });
  try {
    const body = await readFile(full);
    res.writeHead(200, { 'Content-Type': MIME[extname(full)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const room = url.searchParams.get('room');
  const role = url.searchParams.get('role');
  const id = url.searchParams.get('id');

  try {
    if (redisConfigured && url.pathname.startsWith('/api/') && (await handleRedisSignaling(req, res, url, readBody))) return;
    if (req.method === 'POST' && url.pathname === '/api/rooms') {
      const code = newCode();
      if (!code) return json(res, 503, { error: 'no free room codes, try again in a few minutes' });
      const key = newKey();
      rooms.set(code, { key, host: null, viewer: null, pending: new Map(), emptySince: Date.now() });
      latestRoom = code;
      return json(res, 200, { code, key });
    }
    if (req.method === 'GET' && url.pathname === '/api/latest') {
      return latestRoom ? json(res, 200, { code: latestRoom }) : json(res, 404, { error: 'no active room' });
    }
    if (req.method === 'GET' && url.pathname === '/api/info') {
      return json(res, 200, {
        port: PORT,
        lanIps: HOSTED ? [] : lanIps(),
        iceServers: ICE_SERVERS,
        hosted: HOSTED, // the public site: no iPhone screen (needs the Mac app), no "join latest"
        signaling: redisConfigured ? 'redis' : 'memory',
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/join') {
      return joinRoom(req, res, room, role, url.searchParams.get('key'));
    }
    if (req.method === 'POST' && url.pathname === '/api/approve') {
      // Only the room's laptop (its current host session) can allow or deny a phone.
      const entry = rooms.get(room);
      if (!findPeer(room, 'host', id)) return json(res, 403, { error: 'not this room\'s laptop' });
      const ok = approve(entry, url.searchParams.get('viewer'), url.searchParams.get('allow') === '1');
      return json(res, ok ? 200 : 404, { ok });
    }
    if (req.method === 'GET' && url.pathname === '/api/poll') {
      const peer = findPeerOrPending(room, role, id);
      return peer ? poll(req, res, peer) : json(res, 410, { error: 'session gone' });
    }
    if (req.method === 'POST' && url.pathname === '/api/signal') {
      const peer = findPeer(room, role, id);
      if (!peer) return json(res, 410, { error: 'session gone' });
      const target = rooms.get(room)[OTHER[role]];
      if (!target) return json(res, 409, { error: 'peer not connected' });
      deliver(target, { type: 'signal', data: JSON.parse(await readBody(req)) });
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/leave') {
      if (findPeer(room, role, id)) leave(room, role);
      else {
        const entry = rooms.get(room);
        if (entry?.pending.delete(id)) markEmpty(entry);
      }
      return json(res, 200, { ok: true });
    }
    // Awaited so a failure inside lands in the catch below instead of crashing the server.
    if (url.pathname === '/api/display') return await handleDisplay(req, res, url);
    if (req.method === 'GET' && url.pathname === '/api/cursor') return openCursorStream(req, res);
    if (req.method === 'GET' && url.pathname === '/api/cursor-live') return openPhoneCursorStream(req, res);
    if (req.method === 'POST' && url.pathname === '/api/input') return await handleInput(req, res);
    if (req.method === 'GET') return await serveStatic(res, url.pathname);
    json(res, 405, { error: 'method not allowed' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: 'server error' });
  }
});

// Drop peers that stopped polling (closed tab, phone locked, lost network), and rooms left empty.
setInterval(() => {
  const now = Date.now();
  const idle = (peer) => !peer.waiter && now - peer.lastSeen > PEER_TIMEOUT_MS;
  for (const [room, entry] of rooms) {
    for (const role of ['host', 'viewer']) {
      if (entry[role] && idle(entry[role])) leave(room, role, entry);
    }
    for (const [pid, peer] of entry.pending) {
      if (idle(peer)) {
        entry.pending.delete(pid);
        markEmpty(entry);
      }
    }
    if (entry.emptySince && now - entry.emptySince > EMPTY_ROOM_TTL_MS) {
      rooms.delete(room);
      if (latestRoom === room) latestRoom = null;
    }
  }
  for (const [addr, f] of joinFails) if (now - f.since > 60_000) joinFails.delete(addr);
}, 5000);

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopHelper(); process.exit(0); });
process.on('exit', stopHelper);

// Listen on IPv4 explicitly: the phone connects over IPv4, and on macOS a default dual-stack listener
// can start "successfully" on a port another app already holds for IPv4. The phone would then reach
// that other app instead of this one. Binding IPv4 makes such a clash fail loudly, so we move on.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && PORT < PREFERRED_PORT + 20) {
    console.warn(`Port ${PORT} is used by another app, trying ${PORT + 1}…`);
    PORT += 1;
    server.listen(PORT, '0.0.0.0');
  } else {
    console.error(err.message);
    process.exit(1);
  }
});

// Resolves with the port once listening (the desktop app waits for it before opening its window).
// A global, not an export: Vercel treats a server file with exports as a function module and fails.
let markReady;
globalThis.tetherServerReady = new Promise((resolve) => (markReady = resolve));

server.listen(PORT, '0.0.0.0', () => {
  markReady(PORT);
  console.log(`Laptop (Chrome): http://localhost:${PORT}`);
  for (const ip of lanIps()) console.log(`Same Wi-Fi:      http://${ip}:${PORT}`);
  console.log(`Public:          ngrok http ${PORT}`);
  console.log(`TURN relay:      ${process.env.TURN_URLS ? 'on' : 'off (set TURN_URLS/TURN_USERNAME/TURN_CREDENTIAL)'}`);
});
