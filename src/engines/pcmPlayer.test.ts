import { describe, it, expect, beforeEach, vi } from 'vitest';
import { pcm16ToFloat32, PcmPlayer } from './pcmPlayer';

describe('pcm16ToFloat32', () => {
  it('converts little-endian PCM16 samples to float32 range', () => {
    const bytes = new Uint8Array([0xff, 0x7f, 0x00, 0x80]);
    const out = pcm16ToFloat32(bytes);
    expect(out.length).toBe(2);
    expect(out[0]).toBeCloseTo(0.99997, 4);
    expect(out[1]).toBeCloseTo(-1, 4);
  });
});

/** Minimal fake AudioContext covering exactly what PcmPlayer touches. */
class FakeGainParam {
  value = 1;
  cancelScheduledValues = vi.fn();
  setValueAtTime = vi.fn((v: number) => {
    this.value = v;
  });
  linearRampToValueAtTime = vi.fn();
}

class FakeGainNode {
  gain = new FakeGainParam();
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeBufferSourceNode {
  buffer: unknown;
  onended: (() => void) | null = null;
  startedAt?: number;
  stoppedAt?: number;
  connect = vi.fn();
  disconnect = vi.fn();
  start(t: number) {
    this.startedAt = t;
  }
  stop(t?: number) {
    this.stoppedAt = t;
  }
}

class FakeAudioContext {
  currentTime = 0;
  createGain() {
    return new FakeGainNode() as unknown as GainNode;
  }
  createBufferSource() {
    return new FakeBufferSourceNode() as unknown as AudioBufferSourceNode;
  }
  createBuffer(channels: number, frames: number) {
    const channelsData: Float32Array[] = [];
    for (let i = 0; i < channels; i++) channelsData.push(new Float32Array(frames));
    return {
      duration: frames / 48000,
      getChannelData: (ch: number) => channelsData[ch],
    } as unknown as AudioBuffer;
  }
  destination = {} as AudioDestinationNode;
}

function stereoChunk(frames: number): Uint8Array {
  return new Uint8Array(frames * 2 * 2); // 2 channels * 2 bytes/sample
}

describe('PcmPlayer scheduling', () => {
  let ctx: FakeAudioContext;

  beforeEach(() => {
    ctx = new FakeAudioContext();
  });

  it('schedules the first push at now + bufferAheadSec', () => {
    const player = new PcmPlayer(ctx as unknown as AudioContext, 3);
    ctx.currentTime = 10;
    player.push(stereoChunk(100));
    const src = getLastSource(player);
    expect(src.startedAt).toBeCloseTo(13, 5);
  });

  it('chains a second push onto the end of the first with no gap', () => {
    const player = new PcmPlayer(ctx as unknown as AudioContext, 3);
    ctx.currentTime = 10;
    player.push(stereoChunk(48000)); // 1s of audio, ends at 14
    const secondStart = 14;
    player.push(stereoChunk(100));
    const src = getLastSource(player);
    expect(src.startedAt).toBeCloseTo(secondStart, 5);
  });

  it('after cut(), the next push starts near cutAt, not now + bufferAheadSec', () => {
    const player = new PcmPlayer(ctx as unknown as AudioContext, 3);
    ctx.currentTime = 10;
    player.push(stereoChunk(48000 * 5)); // long chunk so it's still playing at cut time
    ctx.currentTime = 11;
    player.cut(0.15);
    const cutAt = 11.15;
    player.push(stereoChunk(100));
    const src = getLastSource(player);
    expect(src.startedAt).toBeGreaterThanOrEqual(cutAt);
    expect(src.startedAt!).toBeLessThanOrEqual(cutAt + 0.2);
  });
});

function getLastSource(player: PcmPlayer): FakeBufferSourceNode {
  const queue = (player as unknown as { queue: { source: FakeBufferSourceNode }[] }).queue;
  return queue[queue.length - 1].source;
}

function getLastBuffer(player: PcmPlayer): { duration: number } {
  const queue = (player as unknown as { queue: { source: FakeBufferSourceNode }[] }).queue;
  return queue[queue.length - 1].source.buffer as { duration: number };
}

describe('PcmPlayer underrun gap-filler', () => {
  let ctx: FakeAudioContext;

  beforeEach(() => {
    ctx = new FakeAudioContext();
  });

  it('loops the last bar when the stream underruns', () => {
    const player = new PcmPlayer(ctx as unknown as AudioContext, 3);
    player.setBarSeconds(2.18); // 110 bpm
    ctx.currentTime = 10;
    player.push(stereoChunk(48000 * 2)); // starts at 13 (10 + bufferAheadSec), ends at 15
    player.push(stereoChunk(48000 * 2)); // chains on, ends at 17
    const lastEndBeforeUnderrun = 17;
    ctx.currentTime = lastEndBeforeUnderrun - 0.2; // gap = 0.2s < LOW_WATER (0.25s)

    player.checkUnderrun();

    const src = getLastSource(player);
    const buf = getLastBuffer(player);
    expect(src.startedAt).toBeCloseTo(lastEndBeforeUnderrun, 5);
    expect(buf.duration).toBeCloseTo(2.18, 5);
    expect(player.stats.loops).toBe(1);
  });

  it('schedules a push arriving during a loop at the loop end, not now + bufferAheadSec', () => {
    const player = new PcmPlayer(ctx as unknown as AudioContext, 3);
    player.setBarSeconds(2.18);
    ctx.currentTime = 10;
    player.push(stereoChunk(48000 * 2)); // starts at 13, ends at 15
    player.push(stereoChunk(48000 * 2)); // chains on, ends at 17
    ctx.currentTime = 17 - 0.2;
    player.checkUnderrun(); // schedules a loop segment: 17 -> 19.18

    ctx.currentTime = 17.5;
    player.push(stereoChunk(100)); // a real chunk arrives mid-loop
    const src = getLastSource(player);
    expect(src.startedAt).toBeCloseTo(19.18, 5);
  });

  it('does not loop after cut() clears the ring (no material)', () => {
    const player = new PcmPlayer(ctx as unknown as AudioContext, 3);
    player.setBarSeconds(2.18);
    ctx.currentTime = 10;
    player.push(stereoChunk(48000 * 2)); // starts at 13, ends at 15
    player.push(stereoChunk(48000 * 2)); // chains on, ends at 17
    ctx.currentTime = 11;
    player.cut(0.15); // clears the ring; lastEnd becomes 11.15

    const lastEndAfterCut = 11.15;
    ctx.currentTime = lastEndAfterCut - 0.2;
    const loopsBefore = player.stats.loops;
    player.checkUnderrun();

    expect(player.stats.loops).toBe(loopsBefore);
  });
});
