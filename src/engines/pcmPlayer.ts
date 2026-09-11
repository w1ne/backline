/** Convert little-endian PCM16 bytes to Float32 samples in [-1, 1]. */
export function pcm16ToFloat32(bytes: Uint8Array): Float32Array {
  const n = bytes.length >> 1;
  const out = new Float32Array(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < n; i++) {
    const sample = view.getInt16(i * 2, true);
    out[i] = sample < 0 ? sample / 0x8000 : sample / 0x7fff;
  }
  return out;
}

const SAMPLE_RATE = 48000;
const CHANNELS = 2;

interface Scheduled {
  source: AudioBufferSourceNode;
  gain: GainNode;
  endTime: number;
}

/**
 * Streams PCM16 stereo chunks from Lyria into scheduled AudioBufferSourceNodes,
 * each behind its own GainNode so a reset can crossfade the seam instead of
 * cutting hard or waiting out the ~2s Lyria control latency.
 */
export class PcmPlayer {
  private queue: Scheduled[] = [];
  private lastEnd = 0;
  private cutUntil = 0; // pushed chunks scheduled before this are dropped after a cut
  private pendingFadeIn = false;

  constructor(
    private ctx: AudioContext,
    private bufferAheadSec = 3,
  ) {}

  push(chunk: Uint8Array): void {
    const floats = pcm16ToFloat32(chunk);
    const frames = floats.length / CHANNELS;
    if (frames <= 0) return;
    const buffer = this.ctx.createBuffer(CHANNELS, frames, SAMPLE_RATE);
    for (let ch = 0; ch < CHANNELS; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < frames; i++) data[i] = floats[i * CHANNELS + ch];
    }

    const startAt = Math.max(this.ctx.currentTime + this.bufferAheadSec, this.lastEnd);
    if (startAt < this.cutUntil) return; // scheduled before the cut point; drop

    const gain = this.ctx.createGain();
    gain.connect(this.ctx.destination);
    if (this.pendingFadeIn) {
      gain.gain.setValueAtTime(0, startAt);
      gain.gain.linearRampToValueAtTime(1, startAt + 0.15);
      this.pendingFadeIn = false;
    } else {
      gain.gain.setValueAtTime(1, startAt);
    }

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    source.start(startAt);

    const endTime = startAt + buffer.duration;
    this.lastEnd = endTime;
    this.queue.push({ source, gain, endTime });
    this.prune();
  }

  /** Fade the currently-audible chunk to silence, drop everything queued after it, and fade the next pushed chunk in. */
  cut(fadeSec = 0.15): void {
    const now = this.ctx.currentTime;
    const cutAt = now + fadeSec;
    for (const s of this.queue) {
      if (s.endTime <= now) continue;
      const startedAlready = s.gain.gain.value !== undefined;
      void startedAlready;
      try {
        s.gain.gain.cancelScheduledValues(now);
        s.gain.gain.setValueAtTime(s.gain.gain.value, now);
        s.gain.gain.linearRampToValueAtTime(0, cutAt);
      } catch {
        // ignore nodes that already ended
      }
      s.source.stop(cutAt);
    }
    this.lastEnd = Math.max(this.lastEnd, cutAt);
    this.cutUntil = cutAt;
    this.pendingFadeIn = true;
    this.prune();
  }

  get playheadLagSec(): number {
    return Math.max(0, this.lastEnd - this.ctx.currentTime);
  }

  stop(): void {
    for (const s of this.queue) {
      try {
        s.source.stop();
      } catch {
        // already stopped
      }
    }
    this.queue = [];
    this.lastEnd = 0;
    this.cutUntil = 0;
    this.pendingFadeIn = false;
  }

  private prune(): void {
    const now = this.ctx.currentTime;
    this.queue = this.queue.filter(s => s.endTime > now);
  }
}
