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

describe('PitchTracker glide detection', () => {
  const voice = { holdFrames: 3, minClarity: 0.7, minAgree: 2 };
  const semis = (base: number, n: number) => base * Math.pow(2, n / 12);
  const midis = (tr: PitchTracker, seq: number[]) => seq.map(v => tr.push(hz(v))?.midi ?? null);

  it('does not report the semitones passed through on a slow slide up a fourth', () => {
    const tr = new PitchTracker(voice);
    for (let i = 0; i < 4; i++) tr.push(hz(A3));
    // 5 semitones in 10 frames = 50 cents per frame, then hold D4
    const slide = Array.from({ length: 10 }, (_, i) => semis(A3, (i + 1) * 0.5));
    const seen = new Set(midis(tr, [...slide, ...Array(4).fill(semis(A3, 5))]));
    expect(seen.has(57)).toBe(true);
    expect(seen.has(62)).toBe(true);
    for (const m of [58, 59, 60, 61]) expect(seen.has(m)).toBe(false);
  });

  it('reports the target note within two frames of the slide settling', () => {
    const tr = new PitchTracker(voice);
    for (let i = 0; i < 4; i++) tr.push(hz(A3));
    const slide = Array.from({ length: 6 }, (_, i) => semis(A3, (i + 1) * 0.5));
    midis(tr, slide);
    const after = midis(tr, Array(3).fill(semis(A3, 3)));
    expect(after[1]).toBe(60);
  });

  it('does not delay a clean step between two held notes', () => {
    const tr = new PitchTracker(voice);
    for (let i = 0; i < 4; i++) tr.push(hz(A3));
    const after = midis(tr, Array(3).fill(semis(A3, 2)));
    expect(after[1]).toBe(59); // same frame the plain rule would have reported it
  });

  it('holds the old note (still stable) during the slide rather than dropping it', () => {
    const tr = new PitchTracker(voice);
    for (let i = 0; i < 4; i++) tr.push(hz(A3));
    const r = tr.push(hz(semis(A3, 0.5)));
    expect(r?.midi).toBe(57);
    expect(tr.push(hz(semis(A3, 1)))?.stable).toBe(true);
  });
});

describe('PitchTracker keeps vouching for a held note through short holds', () => {
  const voice = { holdFrames: 3, minClarity: 0.7, minAgree: 2 };
  it('a breath of one or two frames leaves the note stable, so the listener does not re-trigger it', () => {
    const tr = new PitchTracker(voice);
    for (let i = 0; i < 4; i++) tr.push(hz(A3));
    expect(tr.push(null)).toEqual({ midi: 57, cents: 0, stable: true });
    expect(tr.push(null)?.stable).toBe(true);
    // the next note starts: the window still holds two A3 frames, and the reading stays A3 (not a new note)
    expect(tr.push(hz(A3 * 1.26))).toEqual({ midi: 57, cents: 0, stable: true });
    expect(tr.push(hz(A3 * 1.26))?.midi).toBe(61);
  });
  it('one breathy frame inside a note leaves it stable', () => {
    const tr = new PitchTracker(voice);
    for (let i = 0; i < 4; i++) tr.push(hz(A3));
    expect(tr.push({ hz: A3, clarity: 0.4, t: 0 })).toEqual({ midi: 57, cents: 0, stable: true });
  });
});
