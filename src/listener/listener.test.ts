import { describe, it, expect } from 'vitest';
import { Listener } from './listener';
import type { Source } from './listener';

class Fake implements Source {
  note!: (m: number, v: number, t: number) => void;
  pitch?: (p: { midi: number; cents: number; stable: boolean } | null) => void;
  async start(onNote: Fake['note'], _onLevel: (l: number) => void, onPitch?: Fake['pitch']) {
    this.note = onNote;
    this.pitch = onPitch;
  }
  stop() {}
}

class FailingFake implements Source {
  async start(): Promise<void> {
    throw new Error('boom');
  }
  stop() {}
}

describe('Listener live tempo estimate', () => {
  it('offers a running bpm from six onsets, before the lock at twelve', async () => {
    const a = new Fake();
    const l = new Listener([a]);
    await l.start();
    let t = 1;
    for (let i = 0; i < 5; i++) { a.note(-1, 0.8, t); t += 0.6; }
    expect(l.input.pendingBpm).toBeNull();
    expect(l.input.bpm).toBeNull();
    for (let i = 0; i < 3; i++) { a.note(-1, 0.8, t); t += 0.6; }
    expect(l.input.bpm).toBeNull();
    expect(l.input.pendingBpm).toBeCloseTo(100, 0);
  });
});

describe('Listener continuous pitch', () => {
  it('exposes the stable pitch and folds new stable notes into notesNow/keyDetector', async () => {
    const a = new Fake();
    const l = new Listener([a], ['mic']);
    await l.start();
    expect(l.input.pitch).toBeNull();

    a.pitch!({ midi: 57, cents: 4, stable: true });
    expect(l.input.pitch).toEqual({ midi: 57, cents: 4, stable: true });
    expect(l.input.notesNow).toContain(57);

    a.pitch!(null);
    expect(l.input.pitch).toBeNull();
  });
});

describe('Listener multi-source', () => {
  it('starts all sources and both feed the same lock', async () => {
    const a = new Fake();
    const b = new Fake();
    const l = new Listener([a, b]);
    await l.start();
    let t = 1;
    for (let i = 0; i < 6; i++) { a.note(-1, 0.8, t); t += 0.5; }
    for (let i = 0; i < 6; i++) { b.note(-1, 0.8, t); t += 0.5; }
    expect(l.input.bpm).toBeCloseTo(120, 0);
  });

  it('tolerates one source failing to start and still starts the other', async () => {
    const good = new Fake();
    const bad = new FailingFake();
    const l = new Listener([bad, good]);
    await expect(l.start()).resolves.not.toThrow();
    good.note(60, 0.8, 1);
    expect(l.input.notesNow).toEqual([60]);
  });

  it('reports per-source status via onSourceStatus', async () => {
    const good = new Fake();
    const bad = new FailingFake();
    const l = new Listener([bad, good], ['midi', 'mic']);
    const seen: Record<string, string>[] = [];
    l.onSourceStatus(s => seen.push({ ...s }));
    await l.start();
    expect(l.sourceStatus.mic).toBe('on');
    expect(l.sourceStatus.midi).toBe('denied');
    expect(seen[seen.length - 1]).toEqual({ mic: 'on', midi: 'denied' });
  });
});

describe('Listener', () => {
  it('locks tempo and key from notes', async () => {
    const f = new Fake(); const l = new Listener([f]); await l.start();
    const seq = [60, 64, 67, 72, 67, 64, 60, 62, 64, 65, 67, 69, 71, 72];
    seq.forEach((n, i) => f.note(n, 0.8, 1 + i * 0.5)); // 120 bpm quarter notes
    expect(l.input.bpm).toBeCloseTo(120, 0);
    expect(l.input.key).toEqual({ root: 0, mode: 'major' });
  });

  it('override wins', async () => {
    const l = new Listener([new Fake()]); await l.start(); l.setOverride({ bpm: 90 });
    expect(l.input.bpm).toBe(90);
  });

  it('midi -1 advances tempo but leaves key and notesNow untouched', async () => {
    const f = new Fake(); const l = new Listener([f]); await l.start();
    const seq = [-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1];
    seq.forEach((n, i) => f.note(n, 0.8, 1 + i * 0.5)); // 120 bpm quarter notes
    expect(l.input.bpm).toBeCloseTo(120, 0);
    expect(l.input.key).toBeNull();
    expect(l.input.notesNow).toEqual([]);
  });

  it('in follow mode, tracks a player who speeds up after lock', async () => {
    const f = new Fake(); const l = new Listener([f]); await l.start();
    l.setTempoMode('follow');
    let t = 1;
    for (let i = 0; i < 12; i++) { f.note(-1, 0.8, t); t += 0.5; } // lock at 120bpm
    const lockedBpm = l.input.bpm!;
    expect(lockedBpm).toBeCloseTo(120, 0);
    for (let i = 0; i < 8; i++) { f.note(-1, 0.8, t); t += 60 / 140; } // player speeds to 140
    expect(l.input.bpm!).toBeGreaterThan(lockedBpm);
  });

  it('in locked mode, ignores post-lock speed changes', async () => {
    const f = new Fake(); const l = new Listener([f]); await l.start();
    let t = 1;
    for (let i = 0; i < 12; i++) { f.note(-1, 0.8, t); t += 0.5; } // lock at 120bpm
    const lockedBpm = l.input.bpm!;
    for (let i = 0; i < 8; i++) { f.note(-1, 0.8, t); t += 60 / 140; }
    expect(l.input.bpm!).toBeCloseTo(lockedBpm, 5);
  });

  it('freezes at the followed bpm when switching back to locked, and further onsets do not change it', async () => {
    const f = new Fake(); const l = new Listener([f]); await l.start();
    let t = 1;
    for (let i = 0; i < 12; i++) { f.note(-1, 0.8, t); t += 0.6; } // lock at 100bpm

    l.setTempoMode('follow');
    for (let i = 0; i < 24; i++) { f.note(-1, 0.8, t); t += 60 / 140; } // player speeds toward 140
    const followedBpm = l.input.bpm!;
    expect(followedBpm).toBeGreaterThan(110); // drifted well above the original 100bpm lock

    l.setTempoMode('locked');
    expect(l.input.bpm!).toBeCloseTo(followedBpm, 5); // frozen, not snapped back to 100

    const frozenBpm = l.input.bpm!;
    for (let i = 0; i < 16; i++) { f.note(-1, 0.8, t); t += 60 / 200; } // fast onsets while locked
    expect(l.input.bpm!).toBeCloseTo(frozenBpm, 5);
  });

  it('re-entering follow mode after a freeze seeds the follower from the frozen bpm', async () => {
    const f = new Fake(); const l = new Listener([f]); await l.start();
    let t = 1;
    for (let i = 0; i < 12; i++) { f.note(-1, 0.8, t); t += 0.6; } // lock at 100bpm

    l.setTempoMode('follow');
    for (let i = 0; i < 24; i++) { f.note(-1, 0.8, t); t += 60 / 140; }
    const followedBpm = l.input.bpm!;

    l.setTempoMode('locked');
    l.setTempoMode('follow');
    expect(l.input.bpm!).toBeCloseTo(followedBpm, 5); // no snap back to the 100bpm lock
  });

  it('onNote fires for pitched notes only, with midi/velocity/timeSec', async () => {
    const f = new Fake(); const l = new Listener([f]); await l.start();
    const seen: { midi: number; velocity: number; timeSec: number }[] = [];
    l.onNote(n => seen.push(n));
    f.note(-1, 0.8, 1); // rest: not a pitched note
    f.note(60, 0.6, 2);
    f.note(64, 0.9, 2.5);
    expect(seen).toEqual([
      { midi: 60, velocity: 0.6, timeSec: 2 },
      { midi: 64, velocity: 0.9, timeSec: 2.5 },
    ]);
  });
});

describe('Listener chord following', () => {
  it('reports the chord being played once the app ticks, not on every note', async () => {
    const a = new Fake();
    const l = new Listener([a], ['midi']);
    await l.start();
    const now = performance.now() / 1000;
    // Two beats of a C major arpeggio, ending at "now" so it all sits inside the window.
    [60, 64, 67, 60, 64, 67].forEach((n, i) => a.note(n, 0.9, now - 0.9 + i * 0.15));
    expect(l.input.chord).toBeNull(); // notes alone never move the chord
    expect(l.tickChord(0)).toEqual({ root: 0, quality: 'maj' });
    expect(l.input.chord).toEqual({ root: 0, quality: 'maj' });
  });

  it('falls back to the key tonic triad while nothing conclusive is being played', async () => {
    const a = new Fake();
    const l = new Listener([a], ['midi']);
    await l.start();
    l.setOverride({ key: { root: 9, mode: 'minor' } });
    expect(l.tickChord(0)).toEqual({ root: 9, quality: 'min' });
  });
});

