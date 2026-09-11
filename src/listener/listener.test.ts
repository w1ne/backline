import { describe, it, expect } from 'vitest';
import { Listener } from './listener';
import type { Source } from './listener';

class Fake implements Source {
  note!: (m: number, v: number, t: number) => void;
  async start(onNote: Fake['note']) { this.note = onNote; }
  stop() {}
}

describe('Listener', () => {
  it('locks tempo and key from notes', async () => {
    const f = new Fake(); const l = new Listener(f); await l.start();
    const seq = [60, 64, 67, 72, 67, 64, 60, 62, 64, 65, 67, 69, 71, 72];
    seq.forEach((n, i) => f.note(n, 0.8, 1 + i * 0.5)); // 120 bpm quarter notes
    expect(l.input.bpm).toBeCloseTo(120, 0);
    expect(l.input.key).toEqual({ root: 0, mode: 'major' });
  });

  it('override wins', async () => {
    const l = new Listener(new Fake()); await l.start(); l.setOverride({ bpm: 90 });
    expect(l.input.bpm).toBe(90);
  });

  it('midi -1 advances tempo but leaves key and notesNow untouched', async () => {
    const f = new Fake(); const l = new Listener(f); await l.start();
    const seq = [-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1];
    seq.forEach((n, i) => f.note(n, 0.8, 1 + i * 0.5)); // 120 bpm quarter notes
    expect(l.input.bpm).toBeCloseTo(120, 0);
    expect(l.input.key).toBeNull();
    expect(l.input.notesNow).toEqual([]);
  });

  it('in follow mode, tracks a player who speeds up after lock', async () => {
    const f = new Fake(); const l = new Listener(f); await l.start();
    l.setTempoMode('follow');
    let t = 1;
    for (let i = 0; i < 12; i++) { f.note(-1, 0.8, t); t += 0.5; } // lock at 120bpm
    const lockedBpm = l.input.bpm!;
    expect(lockedBpm).toBeCloseTo(120, 0);
    for (let i = 0; i < 8; i++) { f.note(-1, 0.8, t); t += 60 / 140; } // player speeds to 140
    expect(l.input.bpm!).toBeGreaterThan(lockedBpm);
  });

  it('in locked mode, ignores post-lock speed changes', async () => {
    const f = new Fake(); const l = new Listener(f); await l.start();
    let t = 1;
    for (let i = 0; i < 12; i++) { f.note(-1, 0.8, t); t += 0.5; } // lock at 120bpm
    const lockedBpm = l.input.bpm!;
    for (let i = 0; i < 8; i++) { f.note(-1, 0.8, t); t += 60 / 140; }
    expect(l.input.bpm!).toBeCloseTo(lockedBpm, 5);
  });
});
