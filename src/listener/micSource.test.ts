// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let mockRawContext: unknown;
vi.mock('tone', () => ({
  getContext: () => ({ rawContext: mockRawContext }),
}));

import { OnsetDetector } from './onset';
import { MicSource } from './micSource';
import { detectPitch } from './pitch';
import { PitchTracker, VOICE_PROFILE } from './pitchTracker';
// Execute the same estimator in a worker double; production never runs it on the UI thread.
vi.mock('./pitchWorkerClient', async importOriginal => {
  const original = await importOriginal<typeof import('./pitchWorkerClient')>();
  return { ...original, createPitchWorker: () => {
    const tracker = new PitchTracker(VOICE_PROFILE);
    const worker = { onmessage: null as null | ((e: unknown) => void), onerror: null,
      terminate() {}, postMessage(job: { samples: Float32Array; sampleRate: number; timeSec: number }) {
        const estimate = detectPitch(job.samples, job.sampleRate);
        worker.onmessage?.({ data: { pitch: tracker.push(estimate ? { ...estimate, t: job.timeSec } : null), timeSec: job.timeSec } });
      } };
    return worker;
  } };
});

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

  it('converts audio timestamps into the performance clock used by the listener', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(20000);
    vi.spyOn(OnsetDetector.prototype, 'pushFlux').mockReturnValue(4.9);
    (mockRawContext as { currentTime: number }).currentTime = 5;
    const src = new MicSource();
    const onNote = vi.fn();
    await src.start(onNote, vi.fn());
    vi.advanceTimersByTime(100);
    expect(onNote).toHaveBeenCalled();
    expect(onNote.mock.calls[0][2]).toBeCloseTo(19.9);
    src.stop();
  });

  it('tracks a quiet periodic note below the old one-percent gate', async () => {
    const {ctx, an}=fakeContext();mockRawContext=ctx;
    an.getFloatTimeDomainData=(buf:Float32Array)=>{
      for(let i=0;i<buf.length;i++) buf[i]=.004*Math.sin(2*Math.PI*220*i/48000);
    };
    const src=new MicSource();const onPitch=vi.fn();
    await src.start(vi.fn(),vi.fn(),onPitch);
    vi.advanceTimersByTime(300);
    expect(onPitch.mock.calls.some(([p])=>p?.midi===57 && p.stable)).toBe(true);
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
