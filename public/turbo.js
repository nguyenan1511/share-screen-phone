// Turbo video: WebCodecs H.264 over a WebRTC data channel, for the lowest possible delay.
//
// Regular WebRTC video goes through the receiver's jitter buffer, which holds frames to smooth out
// network hiccups. On a LAN that buffer is pure delay. Here the laptop hardware-encodes each frame
// and sends it as bytes; the phone hardware-decodes it and draws it the moment it arrives.
//
// Wire format on the (ordered, reliable) "video" channel:
//   string  -> JSON control message: {t:"config", codec, codedWidth, codedHeight, description(base64)}
//   binary  -> frame header (14 bytes: u8 1, u8 isKey, u32 byteLength, f64 captureTime ms),
//              followed by byteLength bytes of frame data split into pieces.

const PIECE = 16 * 1024;            // safe message size between Chrome and Safari
// Bytes allowed to wait in the channel before new frames are skipped. Kept small on purpose: the cursor
// shares this connection, so anything queued here also delays the cursor (256 KB ≈ 0.1 s at 15 Mbps).
const MAX_BUFFERED = 256 * 1024;
const KEYFRAME_EVERY_MS = 4000;     // self-heal: periodic keyframe
const HEADER = 14;

export const turboSupported = () =>
  typeof VideoEncoder !== 'undefined' && typeof MediaStreamTrackProcessor !== 'undefined';
export const turboReceiveSupported = () => typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined';

const now = () => performance.timeOrigin + performance.now();
const even = (n) => Math.max(2, Math.floor(n / 2) * 2);

function toBase64(buffer) {
  const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromBase64(text) {
  const s = atob(text);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------- laptop side

export async function startTurboSender({ track, channel, bitrate = 15_000_000, onStats = () => {}, onError = () => {} }) {
  const processor = new MediaStreamTrackProcessor({ track });
  const reader = processor.readable.getReader();
  let stopped = false;
  let configured = null; // {width, height}
  let forceKey = true;
  let lastKeyAt = 0;
  let lastFrame = null; // kept so a keyframe can be produced even when the screen is idle
  let lastFrameAt = 0;
  let lastTimestamp = 0;
  const captureTimes = new Map();
  const stats = { frames: 0, bytes: 0, skipped: 0, since: performance.now(), hw: '?' };

  const encoder = new VideoEncoder({
    output(chunk, meta) {
      if (meta?.decoderConfig) {
        const c = meta.decoderConfig;
        channel.send(JSON.stringify({
          t: 'config', codec: c.codec, codedWidth: c.codedWidth ?? configured?.width, codedHeight: c.codedHeight ?? configured?.height,
          description: c.description ? toBase64(c.description) : null,
        }));
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      const header = new DataView(new ArrayBuffer(HEADER));
      header.setUint8(0, 1);
      header.setUint8(1, chunk.type === 'key' ? 1 : 0);
      header.setUint32(2, data.byteLength);
      header.setFloat64(6, captureTimes.get(chunk.timestamp) ?? now());
      captureTimes.delete(chunk.timestamp);
      try {
        channel.send(header.buffer);
        for (let off = 0; off < data.byteLength; off += PIECE) channel.send(data.subarray(off, off + PIECE));
      } catch (err) {
        onError(err);
      }
      stats.frames++;
      stats.bytes += data.byteLength;
    },
    error: (err) => !stopped && onError(err),
  });

  async function configure(width, height) {
    const base = { width, height, bitrate, framerate: 60, latencyMode: 'realtime', avc: { format: 'avc' } };
    // High → Main → Baseline at level 5.1 (fits up to 4K), hardware first.
    for (const hardwareAcceleration of ['prefer-hardware', 'no-preference']) {
      for (const codec of ['avc1.640033', 'avc1.4d0033', 'avc1.42e033']) {
        const config = { ...base, codec, hardwareAcceleration };
        const { supported } = await VideoEncoder.isConfigSupported(config).catch(() => ({ supported: false }));
        if (supported) {
          encoder.configure(config);
          stats.hw = hardwareAcceleration === 'prefer-hardware' ? 'hardware' : 'any';
          return { width, height };
        }
      }
    }
    throw new Error('No H.264 encoder available for WebCodecs');
  }

  function encode(frame, key) {
    if (key) {
      forceKey = false;
      lastKeyAt = performance.now();
    }
    captureTimes.set(frame.timestamp, now());
    if (captureTimes.size > 120) captureTimes.delete(captureTimes.keys().next().value);
    encoder.encode(frame, { keyFrame: key });
    frame.close();
  }

  (async () => {
    try {
      while (!stopped) {
        const { value: frame, done } = await reader.read();
        if (done || stopped) {
          frame?.close();
          break;
        }
        const width = even(frame.displayWidth);
        const height = even(frame.displayHeight);
        if (!configured || configured.width !== width || configured.height !== height) {
          configured = await configure(width, height);
          forceKey = true;
        }
        lastFrame?.close();
        lastFrame = frame.clone();
        lastFrameAt = performance.now();
        lastTimestamp = frame.timestamp;
        // Skip frames instead of queueing them: a queue is exactly what turns into delay.
        if (!forceKey && (encoder.encodeQueueSize > 1 || channel.bufferedAmount > MAX_BUFFERED)) {
          frame.close();
          stats.skipped++;
          continue;
        }
        encode(frame, forceKey || performance.now() - lastKeyAt > KEYFRAME_EVERY_MS);
      }
    } catch (err) {
      if (!stopped) onError(err);
    }
  })();

  const statsTimer = setInterval(() => {
    const secs = (performance.now() - stats.since) / 1000;
    onStats(
      `Turbo H.264 (${stats.hw}) · ${configured ? `${configured.width}×${configured.height}` : '?'} · ` +
      `${Math.round(stats.frames / secs)} fps · ${((stats.bytes * 8) / secs / 1e6).toFixed(1)} Mbps` +
      (stats.skipped ? ` · skipped ${stats.skipped}` : ''));
    Object.assign(stats, { frames: 0, bytes: 0, skipped: 0, since: performance.now() });
  }, 1000);

  return {
    // Viewer joined or lost sync. If the screen is idle no new frame will come, so re-send the last one.
    requestKeyframe() {
      forceKey = true;
      if (lastFrame && configured && performance.now() - lastFrameAt > 100 && encoder.state === 'configured') {
        lastTimestamp += 1;
        encode(new VideoFrame(lastFrame, { timestamp: lastTimestamp }), true);
      }
    },
    stop() {
      stopped = true;
      clearInterval(statsTimer);
      reader.cancel().catch(() => {});
      lastFrame?.close();
      if (encoder.state !== 'closed') encoder.close();
    },
  };
}

// ---------------------------------------------------------------- phone side

export function createTurboReceiver({ canvas, clockOffset, onFrame = () => {}, needKeyframe = () => {}, onUnsupported = () => {} }) {
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  let decoder = null;
  let config = null;
  let waitingForKey = true;
  let expected = 0, buffer = null, offset = 0, meta = null;
  let errors = [];
  let gaveUp = false;
  const giveUp = () => {
    if (gaveUp) return;
    gaveUp = true;
    onUnsupported();
  };
  const stats = { frames: 0, bytes: 0, delay: 0, since: performance.now() };

  function makeDecoder() {
    if (decoder && decoder.state !== 'closed') decoder.close();
    decoder = new VideoDecoder({
      output(frame) {
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
        }
        ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
        const sentAt = frame.timestamp / 1000;
        frame.close();
        const offsetMs = clockOffset();
        if (offsetMs != null) stats.delay += now() + offsetMs - sentAt;
        stats.frames++;
        onFrame();
      },
      error() {
        // A few errors (e.g. a lost sync) recover with a keyframe; repeated errors mean this device
        // can't decode the stream, so hand back to Standard video instead of looping.
        const t = performance.now();
        errors = errors.filter((e) => t - e < 5000).concat(t);
        if (errors.length > 3) return giveUp();
        waitingForKey = true;
        needKeyframe();
        if (config) {
          makeDecoder();
          const { descriptionText, ...decoderConfig } = config;
          try { decoder.configure(decoderConfig); } catch { giveUp(); }
        }
      },
    });
  }

  function onConfig(msg) {
    const next = {
      codec: msg.codec,
      codedWidth: msg.codedWidth,
      codedHeight: msg.codedHeight,
      optimizeForLatency: true,
      hardwareAcceleration: 'prefer-hardware',
      ...(msg.description ? { description: fromBase64(msg.description) } : {}),
    };
    const same = config && config.codec === next.codec && config.codedWidth === next.codedWidth &&
      config.codedHeight === next.codedHeight && msg.description === config.descriptionText;
    if (same) return;
    config = { ...next, descriptionText: msg.description };
    makeDecoder();
    const { descriptionText, ...decoderConfig } = config;
    try {
      decoder.configure(decoderConfig);
      waitingForKey = true;
    } catch {
      return giveUp();
    }
    // Configure succeeds even for codecs the device can't decode; ask explicitly.
    VideoDecoder.isConfigSupported(decoderConfig)
      .then(({ supported }) => supported || giveUp())
      .catch(() => {});
  }

  function deliver(data, info) {
    if (!decoder || decoder.state !== 'configured') return;
    if (waitingForKey && !info.key) return;
    waitingForKey = false;
    stats.bytes += data.byteLength;
    decoder.decode(new EncodedVideoChunk({ type: info.key ? 'key' : 'delta', timestamp: Math.round(info.sentAt * 1000), data }));
  }

  return {
    onMessage(data) {
      if (typeof data === 'string') {
        const msg = JSON.parse(data);
        if (msg.t === 'config') onConfig(msg);
        return;
      }
      if (!expected) {
        const view = new DataView(data);
        if (view.getUint8(0) !== 1) return;
        expected = view.getUint32(2);
        meta = { key: view.getUint8(1) === 1, sentAt: view.getFloat64(6) };
        buffer = new Uint8Array(expected);
        offset = 0;
        return;
      }
      const piece = new Uint8Array(data);
      buffer.set(piece, offset);
      offset += piece.byteLength;
      if (offset >= expected) {
        expected = 0;
        deliver(buffer, meta);
      }
    },
    readStats() {
      const secs = (performance.now() - stats.since) / 1000;
      const text = `Turbo ${canvas.width}×${canvas.height} · ${Math.round(stats.frames / secs)} fps · ` +
        `${((stats.bytes * 8) / secs / 1e6).toFixed(1)} Mbps` +
        (stats.frames && clockOffset() != null ? ` · delay ≈ ${Math.round(stats.delay / stats.frames)} ms` : '') +
        (decoder ? ` · queue ${decoder.decodeQueueSize}` : '');
      Object.assign(stats, { frames: 0, bytes: 0, delay: 0, since: performance.now() });
      return text;
    },
    close() {
      if (decoder && decoder.state !== 'closed') decoder.close();
    },
  };
}
