import { describe, expect, it } from 'vitest';
import { VoiceTempo, autocorrTempogram, foldBpm, harmonicSum, noteDurationResidual, pickPeaks, refinePeak, tempogramEstimate, DEFAULT_VOICE_TEMPO } from './tempoFromVoice';

/** A singer on a grid: notes of the given beat lengths, a flux burst at every note start. */
function sing(v: VoiceTempo, bpm: number, seconds: number, pattern = [1, 1, 2, 1, 0.5, 0.5, 2]) {
  const beat = 60 / bpm;
  let t = 0.3, i = 0, midi = 60;
  const starts: number[] = [];
  while (t < seconds) {
    starts.push(t);
    v.noteOn(midi + (i % 5), t);
    t += pattern[i++ % pattern.length] * beat;
  }
  v.noteOff(Math.min(t, seconds));
  for (let h = 0; h * 0.01 < seconds; h++) {
    const th = h * 0.01;
    const near = starts.some(s => th >= s && th < s + 0.03);
    v.pushFlux(near ? 1 : 0.02, th);
  }
}

describe('tempogram pieces', () => {
  it('foldBpm folds by octaves into the window', () => {
    expect(foldBpm(200)).toBe(100);
    expect(foldBpm(50)).toBe(100);
    expect(foldBpm(150, 70, 130)).toBe(75);
  });
  it('autocorrTempogram peaks at the pulse period', () => {
    const env = new Float32Array(500);
    for (let i = 0; i < 500; i += 30) env[i] = 1; // 0.6 s at 20 ms = 100 bpm
    expect(Math.round(pickPeaks(autocorrTempogram(env, 0.02, 60, 180))[0].bpm)).toBe(100);
  });
  it('harmonicSum adds the double period support', () => {
    const h = harmonicSum([{ bpm: 200, r: 0.5 }, { bpm: 100, r: 0.4 }, { bpm: 50, r: 0.3 }], 1);
    expect(h.map(p => +p.r.toFixed(2))).toEqual([0.9, 0.7, 0.3]);
  });
  it('refinePeak interpolates between lags', () => {
    const tg = [{ bpm: 60 / 0.58, r: 0.5 }, { bpm: 60 / 0.6, r: 0.9 }, { bpm: 60 / 0.62, r: 0.5 }];
    expect(refinePeak(tg, 100)).toBeCloseTo(100, 5);
    const skew = [{ bpm: 60 / 0.58, r: 0.8 }, { bpm: 60 / 0.6, r: 0.9 }, { bpm: 60 / 0.62, r: 0.2 }];
    expect(refinePeak(skew, 100)).toBeGreaterThan(100);
  });
  it('noteDurationResidual is small at the true beat and large at a wrong one', () => {
    const v = new VoiceTempo();
    sing(v, 100, 20);
    const notes = (v as unknown as { notes: { start: number; end: number; midi: number }[] }).notes;
    expect(noteDurationResidual(notes, 100).residual).toBeLessThan(0.05);
    expect(noteDurationResidual(notes, 137).residual).toBeGreaterThan(0.15);
  });
  it('tempogramEstimate returns null on a window shorter than the minimum', () => {
    expect(tempogramEstimate(new Float32Array(100), [], DEFAULT_VOICE_TEMPO)).toBeNull();
  });
});

describe('VoiceTempo', () => {
  it('has nothing before its window and the beat after it', () => {
    const v = new VoiceTempo();
    sing(v, 96, 14);
    expect(v.estimate(6)).toBeNull();
    const e = v.estimate(12)!;
    expect(e).not.toBeNull();
    expect(Math.abs(e.bpm / 96 - 1)).toBeLessThan(0.04);
    expect(e.confidence).toBeGreaterThan(0.5);
    expect(e.confidence).toBeLessThanOrEqual(1);
  });
  it('folds a fast singer into the singing band', () => {
    const v = new VoiceTempo();
    sing(v, 160, 14, [1, 1, 1, 1]);
    const e = v.estimate(12)!;
    expect(e.bpm).toBeGreaterThanOrEqual(70);
    expect(e.bpm).toBeLessThanOrEqual(130);
    expect(Math.abs(e.bpm / 80 - 1)).toBeLessThan(0.05);
  });
  it('anchors time at the first hop, so a clock that starts at 3600 s works', () => {
    const v = new VoiceTempo();
    const w = new VoiceTempo();
    sing(v, 96, 14);
    // the same performance shifted by an hour on the clock
    const beat = 60 / 96;
    let t = 3600.3, i = 0, midi = 60;
    const starts: number[] = [];
    const pattern = [1, 1, 2, 1, 0.5, 0.5, 2];
    while (t < 3614) { starts.push(t); w.noteOn(midi + (i % 5), t); t += pattern[i++ % pattern.length] * beat; }
    w.noteOff(3614);
    for (let h = 0; h * 0.01 < 14; h++) { const th = 3600 + h * 0.01; w.pushFlux(starts.some(s => th >= s && th < s + 0.03) ? 1 : 0.02, th); }
    expect(w.estimate(3612)!.bpm).toBeCloseTo(v.estimate(12)!.bpm, 0);
    expect(w.estimate(3606)).toBeNull();
  });
  it('ignores non-finite times and resets cleanly', () => {
    const v = new VoiceTempo();
    v.pushFlux(1, NaN);
    expect(v.seconds).toBe(0);
    expect(v.estimate()).toBeNull();
    sing(v, 90, 10);
    expect(v.seconds).toBeGreaterThan(9);
    v.reset();
    expect(v.seconds).toBe(0);
    expect(v.estimate(12)).toBeNull();
  });
});
