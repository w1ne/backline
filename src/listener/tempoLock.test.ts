import { describe, it, expect } from 'vitest';
import { estimateTempo, TempoLock } from './tempoLock';

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
});
