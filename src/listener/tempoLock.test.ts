import { describe, it, expect } from 'vitest';
import { bpmFromOnsets, estimateTempo, TempoLock } from './tempoLock';

function beats(bpm: number, n: number, jitter = 0, start = 1) {
  const p = 60 / bpm;
  return Array.from({ length: n }, (_, i) => start + i * p + (i % 2 ? jitter : -jitter));
}
describe('estimateTempo', () => {
  it('returns null under 12 onsets', () => { expect(estimateTempo(beats(120, 11))).toBeNull(); });
  it('finds 120 bpm from clean quarter notes', () => {
    expect(estimateTempo(beats(120, 16))!.bpm).toBeCloseTo(120, 0);
  });
  it('tolerates 15 ms jitter at 96 bpm', () => {
    expect(Math.abs(estimateTempo(beats(96, 20, 0.015))!.bpm - 96)).toBeLessThan(2);
  });
  it('folds eighth notes at 100 bpm into 60–180 range', () => {
    const bpm = estimateTempo(beats(200, 24))!.bpm; // 200 = eighths at 100
    expect(bpm).toBeCloseTo(100, 0);
  });
  it('reports first onset as downbeat', () => { expect(estimateTempo(beats(120, 16))!.downbeat).toBe(1); });
  it('resolves nearby tempos 10 bpm apart under jitter', () => {
    expect(Math.abs(estimateTempo(beats(100, 24, 0.015))!.bpm - 100)).toBeLessThan(2);
    expect(Math.abs(estimateTempo(beats(110, 24, 0.015))!.bpm - 110)).toBeLessThan(2);
  });
});
describe('TempoLock', () => {
  it('locks once and ignores later onsets', () => {
    const l = new TempoLock();
    beats(110, 12).forEach(t => l.push(t));
    expect(l.locked!.bpm).toBeCloseTo(110, 0);
    beats(140, 12, 0, 20).forEach(t => l.push(t));
    expect(l.locked!.bpm).toBeCloseTo(110, 0);
  });

  it('adoptProvisional reports a lock before the real one arrives', () => {
    const l = new TempoLock();
    expect(l.locked).toBeNull();
    l.adoptProvisional(100, 2);
    expect(l.locked).toEqual({ bpm: 100, downbeat: 2 });
    expect(l.isProvisional).toBe(true);
  });

  it('a real lock replaces a provisional one', () => {
    const l = new TempoLock();
    l.adoptProvisional(100, 2);
    beats(110, 12).forEach(t => l.push(t));
    expect(l.locked!.bpm).toBeCloseTo(110, 0);
    expect(l.isProvisional).toBe(false);
  });

  it('adoptProvisional is a no-op once a real lock exists', () => {
    const l = new TempoLock();
    beats(110, 12).forEach(t => l.push(t));
    l.adoptProvisional(200, 99);
    expect(l.locked!.bpm).toBeCloseTo(110, 0);
  });
});

describe('voice tempo fold', () => {
  /** syllables: two per beat, with every other beat's second syllable missing, so the IOI
   * histogram has a peak at the syllable rate and another at the beat (its half). */
  function syllables(beatBpm: number, beatsN: number, start = 1) {
    const p = 60 / beatBpm;
    const out: number[] = [];
    for (let i = 0; i < beatsN; i++) {
      out.push(start + i * p);
      if (i % 2 === 1) out.push(start + i * p + p / 2);
    }
    return out;
  }
  it('takes the half tempo when the mic onsets also peak there', () => {
    const r = bpmFromOnsets(syllables(87, 20), 12, { voice: true })!;
    expect(Math.abs(r.bpm - 87)).toBeLessThan(2);
  });
  it('keeps the fast tempo for MIDI onsets', () => {
    const r = bpmFromOnsets(syllables(87, 20), 12)!;
    expect(Math.abs(r.bpm - 174)).toBeLessThan(3);
  });
  it('keeps the fast tempo when the half-tempo peak is weak', () => {
    const p = 60 / 87;
    const on: number[] = [];
    for (let i = 0; i < 20; i++) { on.push(1 + i * p); if (i % 5 !== 0) on.push(1 + i * p + p / 2); }
    const r = bpmFromOnsets(on, 12, { voice: true })!;
    expect(Math.abs(r.bpm - 174)).toBeLessThan(3);
  });
  it('never folds below 70', () => {
    const r = bpmFromOnsets(syllables(66, 20), 12, { voice: true })!;
    expect(Math.abs(r.bpm - 132)).toBeLessThan(3);
  });
  it('TempoLock folds when the onsets come from a voice', () => {
    const l = new TempoLock();
    syllables(87, 20).forEach(t => l.push(t, true));
    expect(Math.abs(l.locked!.bpm - 87)).toBeLessThan(2);
  });
});
