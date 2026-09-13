import { describe, expect, it } from 'vitest';
import { autocorrTempogram, combine, durationCluster, foldBpm, harmonicSum, ioiFluxOnsets, ioiNoteOnsets, noteDurationResidual, pickPeaks, tempogramMethod, withStability, type NoteSeg, type TempoMethod, type VoiceStreams } from './methods';

/** A singer on a 100 bpm grid: notes of 1, 1, 2, 1, 1, 2 beats..., flux pulses on every note start. */
function gridStreams(bpm: number, seconds: number, pattern = [1, 1, 2, 1, 0.5, 0.5, 2]): VoiceStreams {
  const beat = 60 / bpm, hopSec = 0.02;
  const notes: NoteSeg[] = [];
  let t = 0.3, i = 0;
  while (t < seconds) {
    const d = pattern[i++ % pattern.length] * beat;
    notes.push({ start: t, end: t + d - 0.02, midi: 60 + (i % 5) });
    t += d;
  }
  const flux = new Float32Array(Math.floor(seconds / hopSec));
  for (const n of notes) { const h = Math.round(n.start / hopSec); if (h < flux.length) flux[h] = 1; }
  const onsets = notes.map(n => ({ t: n.start, strength: 1 }));
  return { onsets, notes, flux, level: new Float32Array(flux.length).fill(0.1), hopSec };
}

describe('foldBpm', () => {
  it('folds into the window by octaves', () => {
    expect(foldBpm(200)).toBe(100);
    expect(foldBpm(50)).toBe(100);
    expect(foldBpm(90, 70, 130)).toBe(90);
  });
});

describe('autocorrTempogram', () => {
  it('peaks at the pulse period', () => {
    const hop = 0.02, env = new Float32Array(500);
    for (let i = 0; i < 500; i += 30) env[i] = 1; // 0.6 s = 100 bpm
    const peaks = pickPeaks(autocorrTempogram(env, hop, 60, 180));
    expect(Math.round(peaks[0].bpm)).toBe(100);
  });
});

describe('noteDurationResidual', () => {
  it('is ~0 at the true beat and large at a wrong one', () => {
    const notes = gridStreams(100, 20).notes;
    expect(noteDurationResidual(notes, 100).residual).toBeLessThan(0.05);
    expect(noteDurationResidual(notes, 137).residual).toBeGreaterThan(0.15);
  });
});

describe('methods on a gridded singer', () => {
  const s = gridStreams(96, 14);
  it('a/b IOI histograms are online and land on the grid or its octave', () => {
    expect(ioiFluxOnsets(s, 1)).toBeNull();
    for (const m of [ioiFluxOnsets, ioiNoteOnsets]) {
      const e = m(s, 12)!;
      expect(e).not.toBeNull();
      expect(Math.abs(Math.log2(foldBpm(e.bpm, 70, 130) / 96))).toBeLessThan(0.06);
    }
  });
  it('tempogram waits for its window then finds the beat', () => {
    const m = tempogramMethod({ noteOctave: true });
    expect(m(s, 6)).toBeNull();
    const e = m(s, 12)!;
    expect(Math.abs(e.bpm / 96 - 1)).toBeLessThan(0.08);
    expect(e.confidence).toBeGreaterThan(0);
  });
  it('duration clustering finds the beat with the mixed-length pattern', () => {
    const e = durationCluster()(s, 12)!;
    expect(Math.abs(e.bpm / 96 - 1)).toBeLessThan(0.08);
  });
  it('combine votes in the singing band with a confidence', () => {
    const e = combine([{ method: tempogramMethod({ noteOctave: true }), weight: 1 }, { method: durationCluster(), weight: 1 }, { method: ioiNoteOnsets, weight: 0.5 }])(s, 12)!;
    expect(Math.abs(e.bpm / 96 - 1)).toBeLessThan(0.08);
    expect(e.confidence).toBeGreaterThan(0.5);
    expect(e.confidence).toBeLessThanOrEqual(1);
  });
  it('combine stays silent until its primary method has spoken', () => {
    const silent: TempoMethod = () => null;
    expect(combine([{ method: silent, weight: 1 }, { method: ioiNoteOnsets, weight: 1 }])(s, 12)).toBeNull();
  });
});

describe('harmonicSum and withStability', () => {
  it('harmonicSum adds half-tempo support to each lag', () => {
    const tg = [{ bpm: 200, r: 0.5 }, { bpm: 100, r: 0.4 }, { bpm: 50, r: 0.3 }];
    const h = harmonicSum(tg, 1);
    expect(h[0].r).toBeCloseTo(0.9); // 200 gets r(100)
    expect(h[1].r).toBeCloseTo(0.7); // 100 gets r(50)
    expect(h[2].r).toBeCloseTo(0.3); // nothing at 25
  });
  it('withStability scores an estimate that changes between windows low', () => {
    const flip: TempoMethod = (_s, now) => ({ bpm: now % 1 === 0 ? 90 : 120, confidence: 1 });
    const s = gridStreams(96, 14);
    const e = withStability(flip, 4, 0.5)(s, 12)!;
    expect(e.bpm).toBe(90);
    expect(e.confidence).toBeCloseTo(0.5); // 2 of 4 earlier windows agree
    const steady = withStability(() => ({ bpm: 90, confidence: 0.5 }), 4, 0.5)(s, 12)!;
    expect(steady.confidence).toBeCloseTo(0.75);
  });
});
