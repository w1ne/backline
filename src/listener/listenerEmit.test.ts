import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Listener } from './listener';
import type { Source } from './listener';
import { bpmFromOnsets } from './tempoLock';

// Wrap (not replace) the onset histogram so the tests below can count how often the
// Listener runs it while leaving its behaviour intact.
vi.mock('./tempoLock', async importOriginal => {
  const actual = await importOriginal<typeof import('./tempoLock')>();
  return { ...actual, bpmFromOnsets: vi.fn(actual.bpmFromOnsets) };
});

class Fake implements Source {
  note!: (m: number, v: number, t: number) => void;
  level!: (l: number) => void;
  pitch?: (p: { midi: number; cents: number; stable: boolean } | null, t?: number) => void;
  async start(onNote: Fake['note'], onLevel: Fake['level'], onPitch?: Fake['pitch']) {
    this.note = onNote;
    this.level = onLevel;
    this.pitch = onPitch;
  }
  stop() {}
}

describe('Listener emit cost', () => {
  beforeEach(() => { vi.mocked(bpmFromOnsets).mockClear(); });

  it('runs the onset histogram once per onset, never from the input getter', async () => {
    const a = new Fake();
    const l = new Listener([a]);
    await l.start();
    let t = 1;
    for (let i = 0; i < 8; i++) { a.note(-1, 0.8, t); t += 0.6; }
    const afterOnsets = vi.mocked(bpmFromOnsets).mock.calls.length;
    expect(afterOnsets).toBe(8);
    for (let i = 0; i < 50; i++) void l.input;
    expect(vi.mocked(bpmFromOnsets).mock.calls.length).toBe(afterOnsets);
    expect(l.input.pendingBpm).toBeCloseTo(100, 0);
  });

  it('throttles level-only emits to 10 Hz, leaving onset and pitch emits untouched', async () => {
    let now = 0;
    const a = new Fake();
    const l = new Listener([a], ['mic'], () => now);
    await l.start();
    let emits = 0;
    l.onChange(() => { emits++; });
    // 31 Hz worth of level samples over one second: no more than ten a second get through.
    for (let i = 0; i < 31; i++) { now = i / 31; a.level(0.5); }
    expect(emits).toBeLessThanOrEqual(11);
    expect(emits).toBeGreaterThanOrEqual(8); // the 31 Hz grid lands one emit every fourth sample
    const before = emits;
    a.note(-1, 0.8, now);
    a.note(-1, 0.8, now);
    a.pitch!({ midi: 60, cents: 0, stable: true }, now);
    a.pitch!({ midi: 62, cents: 0, stable: true }, now);
    expect(emits).toBe(before + 4);
  });

  it('a throttled level still reaches the next emit', async () => {
    let now = 0;
    const a = new Fake();
    const l = new Listener([a], ['mic'], () => now);
    await l.start();
    a.level(0.1);
    now = 0.01;
    a.level(0.9); // inside the throttle window: not emitted on its own
    expect(l.input.inputLevel).toBe(0.9);
  });
});
