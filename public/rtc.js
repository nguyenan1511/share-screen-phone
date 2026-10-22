// Shared signaling + WebRTC helpers for host and viewer pages.

// ngrok free tier shows a warning page unless this header is present.
const HEADERS = { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': '1' };

export async function api(path, options = {}) {
  const res = await fetch(path, { cache: 'no-store', ...options, headers: HEADERS });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || res.statusText), { status: res.status });
  return body;
}

let infoPromise;
export const getInfo = () => (infoPromise ??= api('/api/info'));

// Long-polling signaling channel. Rejoins automatically if the server forgets this session.
// `key` is the room's secret (the laptop has it; phones get it from the QR code / room link). A phone
// without it waits for the laptop to allow it.
export function openSignaling(room, role, { onMessage, onStatus = () => {}, key = '' }) {
  let id = null;
  let closed = false;
  const enc = encodeURIComponent;
  const qs = () => `room=${enc(room)}&role=${enc(role)}&id=${enc(id ?? '')}`;

  async function loop() {
    while (!closed) {
      try {
        if (!id) {
          const joined = await api(`/api/join?room=${enc(room)}&role=${enc(role)}&key=${enc(key)}`, { method: 'POST' });
          id = joined.id;
          onStatus(joined.pending ? 'waiting-approval' : 'online');
        }
        const { messages } = await api(`/api/poll?${qs()}`);
        for (const msg of messages) await onMessage(msg);
      } catch (err) {
        if (closed) return;
        if (err.status === 404 || err.status === 403) return onStatus('room-not-found');
        if (err.status === 429) {
          onStatus('too-many-tries');
          await new Promise((r) => setTimeout(r, 15000));
          continue;
        }
        if (err.status === 410) id = null;
        onStatus('reconnecting');
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
  loop();

  addEventListener('pagehide', () => {
    if (id) fetch(`/api/leave?${qs()}`, { method: 'POST', headers: HEADERS, keepalive: true });
  });

  return {
    send: (data) =>
      id && api(`/api/signal?${qs()}`, { method: 'POST', body: JSON.stringify(data) }).catch(() => {}),
    // Laptop only: allow or deny a phone that joined with just the code.
    approve: (viewerId, allow) =>
      api(`/api/approve?${qs()}&viewer=${enc(viewerId)}&allow=${allow ? 1 : 0}`, { method: 'POST' }),
    close: () => {
      closed = true;
    },
  };
}

// Chrome hides its LAN IP behind a random "xxxx.local" mDNS name. Phones on Wi-Fi that blocks
// multicast can't resolve it, so also send a copy of each host candidate with the real LAN IPs.
export function withLanIps(candidate, lanIps) {
  const parts = candidate.candidate.split(' ');
  if (!parts[4]?.endsWith('.local')) return [candidate];
  return [
    candidate,
    ...lanIps.map((ip) => {
      const copy = [...parts];
      copy[4] = ip;
      return { ...candidate, candidate: copy.join(' ') };
    }),
  ];
}

// ICE candidates can arrive before the remote description; queue them until then.
export async function createPeer(sendSignal, { lanIps = [], mungeRemote } = {}) {
  const { iceServers } = await getInfo();
  const pc = new RTCPeerConnection({ iceServers });
  const pending = [];
  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    for (const candidate of withLanIps(e.candidate.toJSON(), lanIps)) sendSignal({ candidate });
  };

  async function handleSignal(data) {
    if (data.sdp) {
      const sdp = mungeRemote ? { type: data.sdp.type, sdp: mungeRemote(data.sdp.sdp) } : data.sdp;
      await pc.setRemoteDescription(sdp);
      while (pending.length) await pc.addIceCandidate(pending.shift()).catch(() => {});
    } else if (data.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
      else pending.push(data.candidate);
    }
  }

  return { pc, handleSignal };
}

// ---- Low-latency video ----

// H.264 is hardware-encoded on Macs and hardware-decoded on iPhones; VP8/VP9 at 2.5K are software
// on one side or the other, which costs frames and latency.
export function preferH264(transceiver) {
  const codecs = RTCRtpSender.getCapabilities?.('video')?.codecs;
  if (!codecs || !transceiver.setCodecPreferences) return;
  const h264 = codecs.filter((c) => c.mimeType === 'video/H264');
  // Constrained Baseline / packetization-mode=1 first: the most widely hardware-supported profile.
  const rank = (c) => (/packetization-mode=1/.test(c.sdpFmtpLine ?? '') ? 0 : 1) + (/profile-level-id=42e0/.test(c.sdpFmtpLine ?? '') ? 0 : 2);
  h264.sort((a, b) => rank(a) - rank(b));
  try {
    transceiver.setCodecPreferences([...h264, ...codecs.filter((c) => c.mimeType !== 'video/H264')]);
  } catch {}
}

// Chrome's sender reads x-google-start-bitrate from the remote SDP; starting at ~4 Mbps avoids the
// first seconds of blurry, stuttery video while bandwidth estimation ramps up from ~300 kbps.
export function boostStartBitrate(sdp) {
  return sdp.replace(/^a=fmtp:\d+ [^\r\n]*profile-level-id[^\r\n]*/gm, (line) =>
    line.includes('x-google-start-bitrate') ? line : `${line};x-google-start-bitrate=4000`);
}

// Ask the receiver to play frames as soon as they decode instead of buffering for smoothness.
export function lowLatencyReceiver(receiver) {
  try { if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 0; } catch {}
  try { if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = 0; } catch {}
}

// ---- Stats (one line, refreshed every second) ----
export function watchStats(pc, direction, onText) {
  let prev = null;
  const timer = setInterval(async () => {
    if (pc.connectionState === 'closed') return clearInterval(timer);
    const stats = await pc.getStats().catch(() => null);
    if (!stats) return;
    let rtp = null, pair = null;
    stats.forEach((r) => {
      if (r.kind === 'video' && r.type === (direction === 'send' ? 'outbound-rtp' : 'inbound-rtp')) rtp = r;
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected)) pair = r;
    });
    if (!rtp) return;
    const codec = stats.get(rtp.codecId)?.mimeType?.replace('video/', '') ?? '?';
    const path = stats.get(pair?.localCandidateId)?.candidateType;
    const bytes = direction === 'send' ? rtp.bytesSent : rtp.bytesReceived;
    const mbps = prev ? ((bytes - prev.bytes) * 8) / ((rtp.timestamp - prev.ts) * 1000) : 0;
    const parts = [
      `${codec}${rtp.encoderImplementation ? ` (${rtp.encoderImplementation})` : ''}${rtp.decoderImplementation ? ` (${rtp.decoderImplementation})` : ''}`,
      `${rtp.frameWidth ?? '?'}×${rtp.frameHeight ?? '?'}`,
      `${Math.round(rtp.framesPerSecond ?? 0)} fps`,
      `${mbps.toFixed(1)} Mbps`,
    ];
    if (pair?.currentRoundTripTime != null) parts.push(`RTT ${Math.round(pair.currentRoundTripTime * 1000)} ms`);
    if (direction === 'recv' && prev) {
      const emitted = rtp.jitterBufferEmittedCount - prev.emitted;
      if (emitted > 0) parts.push(`buffer ${Math.round(((rtp.jitterBufferDelay - prev.jitter) / emitted) * 1000)} ms`);
      const decoded = rtp.framesDecoded - prev.decoded;
      if (decoded > 0) parts.push(`decode ${Math.round(((rtp.totalDecodeTime - prev.decodeTime) / decoded) * 1000)} ms`);
    }
    if (direction === 'send' && rtp.qualityLimitationReason && rtp.qualityLimitationReason !== 'none') {
      parts.push(`limited by ${rtp.qualityLimitationReason}`);
    }
    if (path) parts.push({ host: 'LAN direct', srflx: 'internet direct', prflx: 'direct', relay: 'TURN relay' }[path] ?? path);
    prev = {
      ts: rtp.timestamp, bytes, emitted: rtp.jitterBufferEmittedCount, jitter: rtp.jitterBufferDelay,
      decoded: rtp.framesDecoded, decodeTime: rtp.totalDecodeTime,
    };
    onText(parts.join(' · '));
  }, 1000);
  return () => clearInterval(timer);
}
