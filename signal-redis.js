// Signaling with rooms kept in Upstash Redis, for hosting on Vercel (or anywhere the server can run as
// several short-lived copies). Same HTTP API and access rules as the in-memory version in server.js:
// rooms have a secret key, the laptop must present it, a phone without it waits for the laptop's Allow.
//
// Differences: nothing is held open. /api/poll answers right away with { messages, poll: true } and the
// client polls again on its own schedule (quick while connecting, slow once video flows peer-to-peer).
// Peers that stop polling expire by TTL; the other side learns it on its next poll.
//
// Data (all with TTLs, so abandoned rooms clean themselves up):
//   r:{code}          room JSON { key }
//   r:{code}:host     peer id of the laptop        r:{code}:viewer   peer id of the phone
//   r:{code}:pending  set of phone ids waiting for Allow
//   p:{id}            peer JSON { room, role, state: seated | pending | retired }, expires when it stops polling
//   q:{id}            list of queued messages for that peer
//   fail:{ip}         wrong codes in the last minute
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
export const redisConfigured = Boolean(REDIS_URL && REDIS_TOKEN);

const ROOM_TTL = 600;      // s: a room without any polling disappears after 10 minutes
const PEER_TTL = 40;       // s: a peer that hasn't polled for this long is gone
const QUEUE_TTL = 120;     // s
const RETIRED_TTL = 15;    // s: a denied/replaced phone can still read why
const FAILS_PER_MINUTE = 20;
const OTHER = { host: 'viewer', viewer: 'host' };

// Upstash REST pipeline: one HTTP request, several commands, results in order.
async function redis(...commands) {
  const res = await fetch(`${REDIS_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`redis ${res.status}`);
  const out = await res.json();
  return out.map((r) => {
    if (r.error) throw new Error(`redis: ${r.error}`);
    return r.result;
  });
}
const parse = (v) => (v ? JSON.parse(v) : null);

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

function keyMatches(room, key) {
  if (!key || !room) return false;
  const a = Buffer.from(String(key)), b = Buffer.from(room.key);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Behind Vercel's proxy every request comes from the proxy; the client is the first forwarded address.
const clientIp = (req) => String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress).split(',')[0].trim();

const push = (id, msg) => [['RPUSH', `q:${id}`, JSON.stringify(msg)], ['EXPIRE', `q:${id}`, QUEUE_TTL]];
const peerRecord = (id, peer, ttl = PEER_TTL) => ['SET', `p:${id}`, JSON.stringify(peer), 'EX', ttl];

async function createRoom(res) {
  const key = randomBytes(16).toString('base64url');
  for (let i = 0; i < 50; i++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    const [ok] = await redis(['SET', `r:${code}`, JSON.stringify({ key }), 'NX', 'EX', ROOM_TTL]);
    if (ok === 'OK') return json(res, 200, { code, key });
  }
  json(res, 503, { error: 'no free room codes, try again in a few minutes' });
}

// Put a peer into its role. A replaced phone is told so (and stops); a replaced laptop session just ends.
async function seat(code, role, id) {
  const [old, other, pending] = await redis(['GET', `r:${code}:${role}`], ['GET', `r:${code}:${OTHER[role]}`], ['SMEMBERS', `r:${code}:pending`]);
  const cmds = [
    ['SET', `r:${code}:${role}`, id, 'EX', ROOM_TTL],
    peerRecord(id, { room: code, role, state: 'seated' }),
  ];
  if (old && old !== id) {
    if (role === 'viewer') cmds.push(peerRecord(old, { room: code, role, state: 'retired' }, RETIRED_TTL), ...push(old, { type: 'replaced' }));
    else cmds.push(['DEL', `p:${old}`]);
  }
  if (other) cmds.push(...push(other, { type: 'peer-joined', role }), ...push(id, { type: 'peer-joined', role: OTHER[role] }));
  // A laptop that (re)joins hears about phones still waiting for its OK.
  if (role === 'host') for (const pid of pending ?? []) cmds.push(...push(id, { type: 'viewer-request', id: pid }));
  await redis(...cmds);
}

async function join(req, res, code, role, key) {
  if (!OTHER[role]) return json(res, 400, { error: 'bad role' });
  const ip = clientIp(req);
  const [fails, roomRaw] = await redis(['GET', `fail:${ip}`], ['GET', `r:${code}`]);
  if (Number(fails) >= FAILS_PER_MINUTE) return json(res, 429, { error: 'too many tries, wait a minute' });
  const countFail = async () => {
    const [n] = await redis(['INCR', `fail:${ip}`]);
    if (n === 1) await redis(['EXPIRE', `fail:${ip}`, 60]);
  };
  const room = parse(roomRaw);
  if (!room) {
    await countFail();
    return json(res, 404, { error: 'room not found' });
  }
  const trusted = keyMatches(room, key);
  if (role === 'host' && !trusted) {
    await countFail();
    return json(res, 403, { error: 'not this room\'s laptop' });
  }
  const id = randomUUID();
  if (role === 'host' || trusted) {
    await seat(code, role, id);
    return json(res, 200, { id });
  }
  // Code only: the laptop has to allow this phone first.
  const [host] = await redis(['GET', `r:${code}:host`]);
  await redis(
    ['SADD', `r:${code}:pending`, id], ['EXPIRE', `r:${code}:pending`, ROOM_TTL],
    peerRecord(id, { room: code, role: 'viewer', state: 'pending' }),
    ...push(id, { type: 'waiting-approval' }),
    ...(host ? push(host, { type: 'viewer-request', id }) : []),
  );
  json(res, 200, { id, pending: true });
}

async function approve(res, code, hostId, viewerId, allow) {
  const [host, viewerRaw] = await redis(['GET', `r:${code}:host`], ['GET', `p:${viewerId}`]);
  if (!hostId || host !== hostId) return json(res, 403, { error: 'not this room\'s laptop' });
  const viewer = parse(viewerRaw);
  if (viewer?.room !== code || viewer.state !== 'pending') return json(res, 404, { ok: false });
  await redis(['SREM', `r:${code}:pending`, viewerId]);
  if (allow) await seat(code, 'viewer', viewerId);
  else await redis(peerRecord(viewerId, { ...viewer, state: 'retired' }, RETIRED_TTL), ...push(viewerId, { type: 'denied' }));
  json(res, 200, { ok: true });
}

async function poll(res, code, role, id) {
  const [peerRaw] = await redis(['GET', `p:${id}`]);
  const peer = parse(peerRaw);
  if (!peer || peer.room !== code || peer.role !== role) return json(res, 410, { error: 'session gone' });
  const other = OTHER[role];
  const [, , , otherId, messages] = await redis(
    ['EXPIRE', `p:${id}`, peer.state === 'retired' ? RETIRED_TTL : PEER_TTL],
    ['EXPIRE', `r:${code}`, ROOM_TTL],
    peer.state === 'seated' ? ['EXPIRE', `r:${code}:${role}`, ROOM_TTL] : ['PING'],
    ['GET', `r:${code}:${other}`],
    ['LPOP', `q:${id}`, 100],
  );
  const out = (messages ?? []).map((m) => JSON.parse(m));
  // The other side stopped polling (closed page, lost network): tell this one, once.
  if (peer.state === 'seated' && otherId) {
    const [alive] = await redis(['EXISTS', `p:${otherId}`]);
    if (!alive) {
      await redis(['DEL', `r:${code}:${other}`]);
      out.push({ type: 'peer-left', role: other });
    }
  }
  json(res, 200, { messages: out, poll: true });
}

async function signal(req, res, code, role, id, readBody) {
  const [mine, otherId] = await redis(['GET', `r:${code}:${role}`], ['GET', `r:${code}:${OTHER[role]}`]);
  if (mine !== id) return json(res, 410, { error: 'session gone' });
  if (!otherId) return json(res, 409, { error: 'peer not connected' });
  const data = JSON.parse(await readBody(req));
  await redis(...push(otherId, { type: 'signal', data }));
  json(res, 200, { ok: true });
}

async function leave(res, code, role, id) {
  const [mine, otherId] = await redis(['GET', `r:${code}:${role}`], ['GET', `r:${code}:${OTHER[role]}`]);
  if (mine === id) {
    await redis(['DEL', `r:${code}:${role}`], ['DEL', `p:${id}`], ...(otherId ? push(otherId, { type: 'peer-left', role }) : []));
  } else {
    await redis(['SREM', `r:${code}:pending`, id], ['DEL', `p:${id}`]);
  }
  json(res, 200, { ok: true });
}

// Returns true when the request was a signaling request (handled here).
export async function handleRedisSignaling(req, res, url, readBody) {
  const room = url.searchParams.get('room');
  const role = url.searchParams.get('role');
  const id = url.searchParams.get('id');
  const route = `${req.method} ${url.pathname}`;
  switch (route) {
    case 'POST /api/rooms': await createRoom(res); return true;
    // A public site has no single "latest" room: it would be a stranger's.
    case 'GET /api/latest': json(res, 404, { error: 'not available on the public site' }); return true;
    case 'POST /api/join': await join(req, res, room, role, url.searchParams.get('key')); return true;
    case 'POST /api/approve': await approve(res, room, id, url.searchParams.get('viewer'), url.searchParams.get('allow') === '1'); return true;
    case 'GET /api/poll': await poll(res, room, role, id); return true;
    case 'POST /api/signal': await signal(req, res, room, role, id, readBody); return true;
    case 'POST /api/leave': await leave(res, room, role, id); return true;
    default: return false;
  }
}
