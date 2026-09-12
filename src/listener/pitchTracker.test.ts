import { describe, it, expect } from 'vitest';
import { PitchTracker } from './pitchTracker';

const A3 = 220;
const hz = (v: number, t = 0) => ({ hz: v, clarity: 0.95, t });

describe('PitchTracker', () => {
  it('locks onto A3 and ignores a single noisy outlier frame', () => {
    const tr = new PitchTracker();
    for (let i = 0; i < 5; i++) tr.push(hz(A3));
    let r = tr.push(hz(A3));
    expect(r!.midi).toBe(57); // A3
    expect(r!.stable).toBe(true);

    r = tr.push(hz(A3 * 1.9)); // wild outlier frame, one of five
    expect(r!.midi).toBe(57);
  });

  it('corrects an octave-doubled/halved frame back to the locked octave', () => {
    const tr = new PitchTracker();
    for (let i = 0; i < 6; i++) tr.push(hz(A3));
    const doubled = tr.push(hz(A3 * 2));
    expect(doubled!.midi).toBe(57);
    const halved = tr.push(hz(A3 / 2));
    expect(halved!.midi).toBe(57);
  });

  it('accepts an octave change after it persists for a full window', () => {
    const tr = new PitchTracker();
    for (let i = 0; i < 6; i++) tr.push(hz(A3));
    let changed = tr.push(hz(A3 * 2));
    for (let i = 1; i < 5; i++) changed = tr.push(hz(A3 * 2));
    expect(changed).toMatchObject({ midi: 69, stable: true });
  });

  it('returns null on silence, after the short dropout hold', () => {
    const tr = new PitchTracker();
    for (let i = 0; i < 6; i++) tr.push(hz(A3));
    tr.push(null); tr.push(null);
    expect(tr.push(null)).toBeNull();
    expect(tr.push(null)).toBeNull();
  });

  it('does not flicker on small jitter around a semitone boundary', () => {
    const tr = new PitchTracker();
    for (let i = 0; i < 6; i++) tr.push(hz(A3));
    // jitter a few cents either side of A3 — should never leave A3 (57)
    const seq = [A3 * 1.01, A3 * 0.99, A3 * 1.02, A3 * 0.98, A3, A3 * 1.015];
    for (const v of seq) {
      const r = tr.push(hz(v));
      expect(r!.midi).toBe(57);
    }
  });

  it('requires clarity to accept a stable reading', () => {
    const tr = new PitchTracker();
    let r: ReturnType<PitchTracker['push']> = null;
    for (let i = 0; i < 6; i++) r = tr.push({ hz: A3, clarity: 0.5, t: i });
    expect(r).toBeNull();
  });
});

describe('PitchTracker voice profile', () => {
  const voice = { holdFrames: 3, minClarity: 0.7, minAgree: 2 };
  const breathy = (v: number) => ({ hz: v, clarity: 0.75, t: 0 });
  it('accepts a hummed note after three breathy frames', () => {
    const tr = new PitchTracker(voice);
    tr.push(breathy(A3)); tr.push(breathy(A3));
    const r = tr.push(breathy(A3));
    expect(r?.stable).toBe(true);
    expect(r?.midi).toBe(57);
  });
  it('the default profile still rejects the same breathy frames', () => {
    const tr = new PitchTracker();
    for (let i = 0; i < 6; i++) tr.push(breathy(A3));
    expect(tr.push(breathy(A3))).toBeNull();
  });
});

describe('PitchTracker dropouts', () => {
  it('rides over a single missing frame without re-triggering the same note', () => {
    const tr = new PitchTracker();
    for (let i = 0; i < 6; i++) tr.push(hz(A3));
    expect(tr.push(null)?.midi).toBe(57);       // one dropped frame: still A3
    expect(tr.push(hz(A3))?.stable).toBe(true); // and stable again at once
  });
  it('lets go after three missing frames', () => {
    const tr = new PitchTracker();
    for (let i = 0; i < 6; i++) tr.push(hz(A3));
    tr.push(null); tr.push(null);
    expect(tr.push(null)).toBeNull();
  });
});
