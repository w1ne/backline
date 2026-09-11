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
    seq.forEach((n, i) => f.note(n, 0.8, 1 + i * 0.5));
    expect(l.input.key).toBeNull();
    expect(l.input.notesNow).toEqual([]);
  });
});
