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

class MutableFake extends Fake {
  muted = false;
  setMuted(m: boolean) { this.muted = m; }
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

describe('Listener provisional tempo lock', () => {
  it('adopts pendingBpm after 8s of onsets when the real 12-onset lock is still pending', async () => {
    const a = new Fake();
    const l = new Listener([a]);
    await l.start();
    // 6 onsets at 100 bpm (0.6s apart) spanning 3s: enough for pendingBpm, not enough for the
    // real lock (needs 12), and well under the 8s provisional wait.
    let t = 1;
    for (let i = 0; i < 6; i++) { a.note(-1, 0.8, t); t += 0.6; }
    expect(l.input.bpm).toBeNull();
    // Keep onsets coming at the same tempo until 8s have passed since the first one.
    while (t - 1 < 8) { a.note(-1, 0.8, t); t += 0.6; }
    expect(l.input.bpm).toBeCloseTo(100, 0);
  });

  it('a real lock (12 onsets) still wins once it lands', async () => {
    const a = new Fake();
    const l = new Listener([a]);
    await l.start();
    let t = 1;
    for (let i = 0; i < 12; i++) { a.note(-1, 0.8, t); t += 0.5; } // 120 bpm, locks for real at 12
    expect(l.input.bpm).toBeCloseTo(120, 0);
  });
});

describe('Listener.setMicMuted', () => {
  it('gates only the mic source, leaving midi sources untouched', async () => {
    const midi = new MutableFake();
    const mic = new MutableFake();
    const l = new Listener([midi, mic], ['midi', 'mic']);
    await l.start();
    l.setMicMuted(true);
    expect(mic.muted).toBe(true);
    expect(midi.muted).toBe(false);
    l.setMicMuted(false);
    expect(mic.muted).toBe(false);
  });

  it('is a no-op for sources without setMuted (e.g. midi-only rigs)', async () => {
    const midi = new Fake();
    const l = new Listener([midi], ['midi']);
    await l.start();
    expect(() => l.setMicMuted(true)).not.toThrow();
  });
});

describe('Listener voice tempo', () => {
  const syllables = (beatBpm: number, beatsN: number) => {
    const p = 60 / beatBpm, out: number[] = [];
    for (let i = 0; i < beatsN; i++) { out.push(1 + i * p); if (i % 2 === 1) out.push(1 + i * p + p / 2); }
    return out;
  };
  it('folds a singer\'s syllable rate to the beat, but not a MIDI player\'s', async () => {
    const mic = new Fake(); const lm = new Listener([mic], ['mic']); await lm.start();
    syllables(87, 20).forEach(t => mic.note(-1, 0.8, t));
    expect(Math.abs(lm.input.bpm! - 87)).toBeLessThan(2);
    const midi = new Fake(); const lk = new Listener([midi], ['midi']); await lk.start();
    syllables(87, 20).forEach(t => midi.note(60, 0.8, t));
    expect(Math.abs(lk.input.bpm! - 174)).toBeLessThan(3);
  });
  it('a held sung note weighs in the key by how long it is held', async () => {
    const a = new Fake(); let now = 0; const l = new Listener([a], ['mic'], () => now); await l.start();
    // A F G B A held half a second each, frames every 50 ms: locks A minor from coverage
    // (the correlation alone would not, see keyDetector.test.ts)
    for (const midi of [69, 77, 79, 71, 69]) for (let i = 0; i < 10; i++) { now += 0.05; a.pitch!({ midi, cents: 0, stable: true }); }
    expect(l.input.key).toEqual({ root: 9, mode: 'minor' });
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


describe('Listener activity tracking', () => {
  it('feeds onsets into the dynamics the band reads', async () => {
    const a = new Fake();
    const l = new Listener([a]);
    await l.start();
    expect(l.input.dynamics.intensity).toBe(0);

    // four notes a beat for four beats at 120 bpm
    let t = 1;
    for (let beat = 1; beat <= 4; beat++) {
      for (let i = 0; i < 4; i++) a.note(60, 0.8, t + i * 0.125 + 0.05);
      t += 0.5;
      l.tickBeat(beat, t);
    }
    expect(l.input.dynamics.intensity).toBeGreaterThan(0.5);
    expect(l.input.dynamics.space).toBe(false);

    // then two beats of silence
    for (let beat = 5; beat <= 6; beat++) {
      t += 0.5;
      l.tickBeat(beat, t);
    }
    expect(l.input.dynamics.space).toBe(true);
    expect(l.input.dynamics.silenceBeats).toBeGreaterThan(1.5);
  });

  it('emits on every beat tick, so the UI follows without polling', async () => {
    const a = new Fake();
    const l = new Listener([a]);
    await l.start();
    let emitted = 0;
    l.onChange(() => { emitted++; });
    l.tickBeat(1, 1);
    l.tickBeat(2, 1.5);
    expect(emitted).toBe(2);
  });
});


describe('microphone melody events', () => {
  it('forwards each distinct stable pitch to engines without adding tempo onsets', async () => {
    const mic = new Fake();
    const listener = new Listener([mic], ['mic']);
    const notes: number[] = [];
    listener.onNote(n => { notes.push(n.midi); expect(n.timeSec).toBeGreaterThanOrEqual(0); });
    await listener.start();
    mic.pitch!({ midi: 60, cents: 0, stable: false });
    mic.pitch!({ midi: 60, cents: 0, stable: true });
    mic.pitch!({ midi: 60, cents: 2, stable: true });
    mic.pitch!({ midi: 64, cents: 0, stable: true });
    mic.pitch!(null);
    mic.pitch!({ midi: 64, cents: 0, stable: true });
    expect(notes).toEqual([60, 64, 64]);
    expect(listener.input.onsets).toBe(0);
  });
});


describe('independent source readiness', () => {
  it('publishes microphone readiness while MIDI permission is still pending', async () => {
    let ready!: () => void;
    const pending: Source = { start: () => new Promise<void>(resolve => { ready = resolve; }), stop() {} };
    const mic = new Fake();
    const listener = new Listener([pending, mic], ['midi', 'mic']);
    const seen: string[] = [];
    listener.onSourceStatus(s => seen.push(s.mic));
    const started = listener.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toContain('on');
    ready();
    await started;
  });
});

describe('Listener preserves performer pitches', () => {
  it('preserves an out-of-key sung pitch even after a key is known', async () => {
    const a = new Fake();
    const l = new Listener([a]);
    await l.start();
    const heard: number[] = [];
    l.onNote(n => heard.push(n.midi));
    // establish C major from MIDI-style notes
    for (const n of [60, 62, 64, 65, 67, 69, 71, 72, 64, 67, 60]) a.note(n, 0.8, 1);
    expect(l.input.key).toEqual({ root: 0, mode: 'major' });
    heard.length = 0;
    a.pitch!({ midi: 61, cents: 0, stable: true }); // Intentional C#4 must reach the model unchanged
    expect(heard).toHaveLength(1);
    expect(heard).toEqual([61]);
  });
  it('passes sung pitches through untouched while no key is known', async () => {
    const a = new Fake();
    const l = new Listener([a]);
    await l.start();
    const heard: number[] = [];
    l.onNote(n => heard.push(n.midi));
    a.pitch!({ midi: 61, cents: 0, stable: true });
    expect(heard).toEqual([61]);
  });
});

it('closes mic lifecycle at captured transition, silence and mute times with stable IDs', async () => {
  const mic = new Fake(); let now = 20;
  const listener = new Listener([mic], ['mic'], () => now);
  const seen: import('./performanceEvent').PerformanceEvent[] = [];
  listener.onPerformance(e => seen.push(e));
  await listener.start();
  const pitch = mic.pitch as (p: import('./pitchTracker').StablePitch | null, t?: number) => void;
  pitch({ midi: 60, cents: 0, stable: true, confidence: .9 }, 10);
  pitch({ midi: 60, cents: 0, stable: true }, 10.5);
  pitch({ midi: 64, cents: 0, stable: true }, 11);
  pitch(null, 12);
  expect(seen.map(e => e.type)).toEqual(['note_on', 'note_off', 'note_on', 'note_off']);
  expect(seen[0]).toMatchObject({ source: 'mic', confidence: .9, timeSec: 10 });
  expect(seen[1]).toMatchObject({ id: seen[0].id, durationSec: 1, timeSec: 11 });
  expect(seen[3]).toMatchObject({ id: seen[2].id, durationSec: 1, timeSec: 12 });
  pitch({ midi: 67, cents: 0, stable: true }, 19);
  listener.setMicMuted(true);
  expect(seen.at(-1)).toMatchObject({ type: 'note_off', durationSec: 1 });
});

it('exports only explicit manual preferences, without exposing mutable key state', () => {
  const listener = new Listener([new Fake()]);
  expect(listener.manualOverrides).toEqual({bpmOverride:null,keyOverride:null});
  listener.setOverride({bpm:90,key:{root:9,mode:'minor'}});
  const copy = listener.manualOverrides;
  expect(copy).toEqual({bpmOverride:90,keyOverride:{root:9,mode:'minor'}});
  copy.keyOverride!.root = 0;
  expect(listener.manualOverrides.keyOverride?.root).toBe(9);
  listener.setOverride({bpm:undefined,key:undefined});
  expect(listener.manualOverrides).toEqual({bpmOverride:null,keyOverride:null});
});
