import { describe, it, expect, vi } from 'vitest';

// SampledDrumVoice is not exported (internal to sampledVoices.ts); exercised through
// makeSampledDrums with a fake smplr DrumMachine, covering the fallback contract Players
// relies on: play the synth immediately, switch to samples once the kit's `ready` resolves.

interface FakeVoice { triggerAttackRelease: (...a: unknown[]) => void; dispose: () => void }

function fakeVoice(): FakeVoice & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return { calls, triggerAttackRelease: (...a) => calls.push(a), dispose: () => undefined };
}

describe('sampled drums fallback', () => {
  it('plays the fallback synth until the kit resolves, then switches to samples', async () => {
    vi.resetModules();
    let resolveReady!: () => void;
    const ready = new Promise<void>(res => { resolveReady = res; });
    const starts: unknown[] = [];
    vi.doMock('smplr', () => ({
      DrumMachine: () => ({ ready, start: (e: unknown) => { starts.push(e); return () => undefined; } }),
      ElectricPiano: () => ({ ready: Promise.resolve(), start: () => () => undefined }),
      Soundfont: () => ({ ready: Promise.resolve(), start: () => () => undefined }),
    }));
    const { makeSampledDrums } = await import('./sampledVoices');
    const fallback = { kick: fakeVoice(), snare: fakeVoice(), hat: fakeVoice(), openHat: fakeVoice(), crash: fakeVoice() };
    const ctx = {} as AudioContext;
    const dest = {} as AudioNode;
    const drums = makeSampledDrums(ctx, dest, 'acoustic', fallback);

    // Before the kit is ready: falls straight through to the synth.
    drums.kick.triggerAttackRelease('C1', 0.2, 1.0, 0.8);
    expect(fallback.kick.calls.length).toBe(1);
    expect(starts.length).toBe(0);

    resolveReady();
    await ready;
    await Promise.resolve();

    // Once ready: hits the sampled kit instead, and no longer touches the fallback.
    drums.kick.triggerAttackRelease('C1', 0.2, 2.0, 0.5);
    expect(fallback.kick.calls.length).toBe(1);
    expect(starts.length).toBe(1);
    expect(starts[0]).toMatchObject({ note: 'kick', time: 2.0, velocity: 64 });
  });

  it('maps each drum role to its kit-specific sample group, per kit', async () => {
    vi.resetModules();
    const starts: Record<string, unknown[]> = { acoustic: [], electronic: [] };
    let current = 'acoustic';
    vi.doMock('smplr', () => ({
      DrumMachine: () => ({
        ready: Promise.resolve(),
        start: (e: unknown) => { starts[current].push(e); return () => undefined; },
      }),
      ElectricPiano: () => ({ ready: Promise.resolve(), start: () => () => undefined }),
      Soundfont: () => ({ ready: Promise.resolve(), start: () => () => undefined }),
    }));
    const { makeSampledDrums } = await import('./sampledVoices');
    const fallback = { kick: fakeVoice(), snare: fakeVoice(), hat: fakeVoice(), openHat: fakeVoice(), crash: fakeVoice() };

    current = 'acoustic';
    const acoustic = makeSampledDrums({} as AudioContext, {} as AudioNode, 'acoustic', fallback);
    await Promise.resolve();
    acoustic.hat.triggerAttackRelease('C6', 0.05, 1, 0.5);
    acoustic.crash.triggerAttackRelease('C6', 1.2, 1, 0.5);

    current = 'electronic';
    const electronic = makeSampledDrums({} as AudioContext, {} as AudioNode, 'electronic', fallback);
    await Promise.resolve();
    electronic.hat.triggerAttackRelease('C6', 0.05, 1, 0.5);
    electronic.crash.triggerAttackRelease('C6', 1.2, 1, 0.5);

    expect(starts.acoustic).toEqual(expect.arrayContaining([expect.objectContaining({ note: 'hhclosed' }), expect.objectContaining({ note: 'crash' })]));
    expect(starts.electronic).toEqual(expect.arrayContaining([expect.objectContaining({ note: 'hihat-close' }), expect.objectContaining({ note: 'cymbal' })]));
  });

  it('cancels scheduled sample hits when the voice is disposed', async () => {
    vi.resetModules();
    const stop = vi.fn();
    vi.doMock('smplr', () => ({
      DrumMachine: () => ({ ready: Promise.resolve(), start: () => stop }),
      ElectricPiano: () => ({ ready: Promise.resolve(), start: () => () => undefined }),
      Soundfont: () => ({ ready: Promise.resolve(), start: () => () => undefined }),
    }));
    const { makeSampledDrums } = await import('./sampledVoices');
    const fallback = { kick: fakeVoice(), snare: fakeVoice(), hat: fakeVoice(), openHat: fakeVoice(), crash: fakeVoice() };
    const drums = makeSampledDrums({} as AudioContext, {} as AudioNode, 'acoustic', fallback);
    await Promise.resolve();
    drums.kick.triggerAttackRelease('C1', 0.2, 2, 0.8);
    drums.kick.dispose();
    expect(stop).toHaveBeenCalledOnce();
  });
});

describe('sampled melodic voices (bass/keys/lead) fallback', () => {
  async function withMockedSmplr<T>(run: (mod: typeof import('./sampledVoices'), starts: Record<string, unknown[]>) => Promise<T>) {
    vi.resetModules();
    const starts: Record<string, unknown[]> = { bass: [], keys: [], lead: [] };
    vi.doMock('smplr', () => ({
      DrumMachine: () => ({ ready: Promise.resolve(), start: () => () => undefined }),
      ElectricPiano: () => ({ ready: Promise.resolve(), start: (e: unknown) => { starts.keys.push(e); return () => undefined; } }),
      Soundfont: (_ctx: unknown, opts: { instrument: string }) => ({
        ready: Promise.resolve(),
        start: (e: unknown) => { starts[opts.instrument.includes('bass') ? 'bass' : 'lead'].push(e); return () => undefined; },
      }),
    }));
    const mod = await import('./sampledVoices');
    return run(mod, starts);
  }

  it('bass converts the frequency Players hands it back to a MIDI note, and honours velocity', async () => {
    await withMockedSmplr(async ({ makeSampledBass }, starts) => {
      const fallback = fakeVoice();
      const bass = makeSampledBass({} as AudioContext, {} as AudioNode, fallback);
      await Promise.resolve();
      const Tone = await import('tone');
      const freq = Tone.Frequency(40, 'midi').toFrequency(); // matches Players.schedule()'s call shape
      bass.triggerAttackRelease(freq, 0.5, 1.5, 0.7);

      expect(fallback.calls.length).toBe(0);
      expect(starts.bass).toEqual([expect.objectContaining({ note: 40, time: 1.5, duration: 0.5, velocity: 89 })]);
    });
  });

  it('keys and lead fall back to their synth until the soundfont is ready', async () => {
    vi.resetModules();
    let resolveReady!: () => void;
    const ready = new Promise<void>(res => { resolveReady = res; });
    const starts: unknown[] = [];
    vi.doMock('smplr', () => ({
      DrumMachine: () => ({ ready: Promise.resolve(), start: () => () => undefined }),
      ElectricPiano: () => ({ ready, start: (e: unknown) => { starts.push(e); return () => undefined; } }),
      Soundfont: () => ({ ready: Promise.resolve(), start: () => () => undefined }),
    }));
    const { makeSampledKeys } = await import('./sampledVoices');
    const fallback = fakeVoice();
    const keys = makeSampledKeys({} as AudioContext, {} as AudioNode, fallback);

    keys.triggerAttackRelease(261.6, 1, 1, 0.5);
    expect(fallback.calls.length).toBe(1);
    expect(starts.length).toBe(0);

    resolveReady();
    await ready;
    await Promise.resolve();

    keys.triggerAttackRelease(261.6, 1, 2, 0.5);
    expect(fallback.calls.length).toBe(1);
    expect(starts.length).toBe(1);
  });
});
