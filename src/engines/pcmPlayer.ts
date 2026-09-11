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
const LOW_WATER = 0.25;
const LOOP_FADE_SEC = 0.02;
const DEFAULT_BAR_SEC = 2;

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
  /** undefined = start at full gain; otherwise fade in from 0 over this many seconds. */
  private pendingFadeInSec?: number;
  /** lead time before the next push's scheduled start, when there's no continuous audio to chain onto */
  private nextLead: number;
  private barSeconds = DEFAULT_BAR_SEC;
  /** Ring of the most recently received audio (interleaved stereo Float32), for underrun looping. */
  private ringChunks: Float32Array[] = [];
  private ringFrames = 0;
  private watchdog?: ReturnType<typeof setInterval>;
  stats = { loops: 0, starvedSec: 0 };

  constructor(
    private ctx: AudioContext,
    private bufferAheadSec = 3,
  ) {
    this.nextLead = bufferAheadSec;
    this.watchdog = setInterval(() => this.checkUnderrun(), 50);
  }

  /** Bar length in seconds (240 / bpm), used both for the loop segment length and ring capacity. */
  setBarSeconds(sec: number): void {
    this.barSeconds = sec;
    this.trimRing();
  }

  push(chunk: Uint8Array): void {
    const floats = pcm16ToFloat32(chunk);
    const frames = floats.length / CHANNELS;
    if (frames <= 0) return;
    const buffer = this.ctx.createBuffer(CHANNELS, frames, SAMPLE_RATE);
    for (let ch = 0; ch < CHANNELS; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < frames; i++) data[i] = floats[i * CHANNELS + ch];
    }
    this.pushToRing(floats, frames);

    // Chain onto continuous playback; only insert a lead gap when starting cold
    // (first chunk ever) or right after a cut, which uses a short 0.2s lead
    // instead of the full 3s buffer-ahead.
    const startAt = this.lastEnd > this.ctx.currentTime ? this.lastEnd : this.ctx.currentTime + this.nextLead;
    this.nextLead = this.bufferAheadSec;

    const gain = this.ctx.createGain();
    gain.connect(this.ctx.destination);
    if (this.pendingFadeInSec !== undefined) {
      gain.gain.setValueAtTime(0, startAt);
      gain.gain.linearRampToValueAtTime(1, startAt + this.pendingFadeInSec);
      this.pendingFadeInSec = undefined;
    } else {
      gain.gain.setValueAtTime(1, startAt);
    }

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
    };
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
      try {
        const holdValue = s.gain.gain.value;
        s.gain.gain.cancelScheduledValues(now);
        s.gain.gain.setValueAtTime(holdValue, now);
        s.gain.gain.linearRampToValueAtTime(0, cutAt);
      } catch {
        // ignore nodes that already ended
      }
      s.source.stop(cutAt);
    }
    this.lastEnd = cutAt;
    this.nextLead = 0.2;
    this.pendingFadeInSec = 0.15;
    this.ringChunks = [];
    this.ringFrames = 0;
    this.prune();
  }

  /** Runs the underrun check: if the playhead is about to starve and there's ring
   * material to loop, schedule loop segment(s) until the buffer is topped back up. */
  checkUnderrun(): void {
    const barFrames = Math.round(this.barSeconds * SAMPLE_RATE);
    while (
      this.lastEnd - this.ctx.currentTime < LOW_WATER &&
      this.ringFrames >= barFrames &&
      barFrames > 0
    ) {
      this.scheduleLoopSegment(barFrames);
    }
  }

  private scheduleLoopSegment(barFrames: number): void {
    const startAt = this.lastEnd;
    const loopFloats = this.extractRingTail(barFrames);
    const buffer = this.ctx.createBuffer(CHANNELS, barFrames, SAMPLE_RATE);
    for (let ch = 0; ch < CHANNELS; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < barFrames; i++) data[i] = loopFloats[i * CHANNELS + ch];
    }

    const gain = this.ctx.createGain();
    gain.connect(this.ctx.destination);
    const fadeSec = Math.min(LOOP_FADE_SEC, buffer.duration / 2);
    // Equal-power-ish fade in at the start and fade out at the end so the loop
    // seam (into and out of it) is smoothed rather than clicking.
    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(1, startAt + fadeSec);
    gain.gain.setValueAtTime(1, startAt + buffer.duration - fadeSec);
    gain.gain.linearRampToValueAtTime(0, startAt + buffer.duration);

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
    };
    source.start(startAt);

    const endTime = startAt + buffer.duration;
    this.lastEnd = endTime;
    this.queue.push({ source, gain, endTime });
    this.stats.loops++;
    this.stats.starvedSec += buffer.duration;
    // The next real chunk to arrive should crossfade in over the loop's tail fade.
    this.pendingFadeInSec = fadeSec;
    this.prune();
  }

  /** Appends newly received interleaved-stereo audio to the ring, trimmed to capacity. */
  private pushToRing(floats: Float32Array, frames: number): void {
    if (frames <= 0) return;
    this.ringChunks.push(floats);
    this.ringFrames += frames;
    this.trimRing();
  }

  private trimRing(): void {
    const capacityFrames = Math.round(Math.max(this.barSeconds * 2, DEFAULT_BAR_SEC * 2) * SAMPLE_RATE);
    while (this.ringFrames > capacityFrames && this.ringChunks.length > 1) {
      const dropped = this.ringChunks.shift()!;
      this.ringFrames -= dropped.length / CHANNELS;
    }
  }

  /** Returns the last `frames` frames of ring audio, interleaved stereo. Caller must have
   * already checked ringFrames >= frames. */
  private extractRingTail(frames: number): Float32Array {
    const out = new Float32Array(frames * CHANNELS);
    let remaining = frames * CHANNELS;
    let writeEnd = out.length;
    for (let i = this.ringChunks.length - 1; i >= 0 && remaining > 0; i--) {
      const chunk = this.ringChunks[i];
      const take = Math.min(chunk.length, remaining);
      const chunkStart = chunk.length - take;
      out.set(chunk.subarray(chunkStart), writeEnd - take);
      writeEnd -= take;
      remaining -= take;
    }
    return out;
  }

  get playheadLagSec(): number {
    return Math.max(0, this.lastEnd - this.ctx.currentTime);
  }

  stop(): void {
    if (this.watchdog !== undefined) clearInterval(this.watchdog);
    this.watchdog = undefined;
    for (const s of this.queue) {
      try {
        s.source.stop();
      } catch {
        // already stopped
      }
      s.source.disconnect();
      s.gain.disconnect();
    }
    this.queue = [];
    this.lastEnd = 0;
    this.nextLead = this.bufferAheadSec;
    this.pendingFadeInSec = undefined;
    this.ringChunks = [];
    this.ringFrames = 0;
  }

  private prune(): void {
    const now = this.ctx.currentTime;
    const stale = this.queue.filter(s => s.endTime <= now);
    for (const s of stale) {
      s.source.disconnect();
      s.gain.disconnect();
    }
    this.queue = this.queue.filter(s => s.endTime > now);
  }
}
