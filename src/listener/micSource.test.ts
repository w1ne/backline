// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let mockRawContext: unknown;
vi.mock('tone', () => ({
  getContext: () => ({ rawContext: mockRawContext }),
}));

import { MicSource } from './micSource';

/** Analyser stub whose time-domain buffer changes on every call so the poll
 *  fallback's "has the analyser refilled" hash check never skips a frame. */
function fakeAnalyser() {
  let tick = 0;
  return {
    fftSize: 2048,
    smoothingTimeConstant: 0,
    getFloatTimeDomainData: (buf: Float32Array) => {
      tick += 1;
      for (let i = 0; i < buf.length; i++) buf[i] = 0.2 * Math.sin(i + tick);
    },
  };
}

function fakeContext() {
  const an = fakeAnalyser();
  return {
    ctx: {
      sampleRate: 48000,
      currentTime: 0,
      createMediaStreamSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
      createAnalyser: () => an,
      audioWorklet: { addModule: () => Promise.reject(new Error('no worklet in jsdom')) },
    } as unknown as AudioContext,
    an,
  };
}

describe('MicSource.setMuted', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    const { ctx } = fakeContext();
    mockRawContext = ctx;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] } as unknown as MediaStream) },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('emits levels/onsets/pitch normally, then stops while muted, then resumes on unmute', async () => {
    const src = new MicSource();
    const onNote = vi.fn();
    const onLevel = vi.fn();
    const onPitch = vi.fn();
    await src.start(onNote, onLevel, onPitch);

    vi.advanceTimersByTime(500);
    expect(onLevel).toHaveBeenCalled();
    expect(onPitch).toHaveBeenCalled();

    onNote.mockClear();
    onLevel.mockClear();
    onPitch.mockClear();

    src.setMuted(true);
    // muting emits one immediate zero/blank so the UI doesn't hold a stale reading
    expect(onLevel).toHaveBeenCalledWith(0);
    expect(onPitch).toHaveBeenCalledWith(null);
    onLevel.mockClear();
    onPitch.mockClear();

    vi.advanceTimersByTime(500);
    expect(onNote).not.toHaveBeenCalled();
    expect(onLevel).not.toHaveBeenCalled();
    expect(onPitch).not.toHaveBeenCalled();

    src.setMuted(false);
    vi.advanceTimersByTime(500);
    expect(onLevel).toHaveBeenCalled();
    expect(onPitch).toHaveBeenCalled();

    src.stop();
  });

  it('is idempotent when set to the same value', async () => {
    const src = new MicSource();
    const onLevel = vi.fn();
    await src.start(vi.fn(), onLevel, vi.fn());
    src.setMuted(true);
    onLevel.mockClear();
    src.setMuted(true); // no second "muted -> emit zero" transition
    expect(onLevel).not.toHaveBeenCalled();
    src.stop();
  });
});
