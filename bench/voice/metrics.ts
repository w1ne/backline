import type { Note } from './synth';
import type { DetectedNote, RawFrame } from './driver';

const centsBetween = (a: number, b: number) => 1200 * Math.log2(a / b);
const midiToHz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

function truthMidiAt(notes: Note[], t: number): number | null {
  for (const n of notes) if (t >= n.start && t < n.end) return n.midi;
  return null;
}

export interface PitchAccuracyResult {
  /** voiced frames = frames where truth has an active note */
  voicedFrames: number;
  accurateFrames: number;
  octaveErrorFrames: number;
  accuracyPct: number;
  octaveErrorPct: number;
}

/** Raw (pre-tracker) pitch accuracy against ground truth, ±50 cents tolerance. */
export function rawPitchAccuracy(frames: RawFrame[], notes: Note[]): PitchAccuracyResult {
  let voiced = 0, accurate = 0, octave = 0;
  for (const f of frames) {
    const truthMidi = truthMidiAt(notes, f.t);
    if (truthMidi === null) continue;
    voiced++;
    if (f.hz === null) continue;
    const trueHz = midiToHz(truthMidi);
    const diff = centsBetween(f.hz, trueHz);
    if (Math.abs(diff) <= 50) { accurate++; continue; }
    if (Math.abs(Math.abs(diff) - 1200) <= 50) octave++;
  }
  return {
    voicedFrames: voiced,
    accurateFrames: accurate,
    octaveErrorFrames: octave,
    accuracyPct: voiced > 0 ? (100 * accurate) / voiced : NaN,
    octaveErrorPct: voiced > 0 ? (100 * octave) / voiced : NaN,
  };
}

export interface SegmentationResult {
  precision: number;
  recall: number;
  f1: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  /** seconds from true note start to the matched detection, one per true positive */
  latencies: number[];
}

/**
 * A detected note matches a truth note when the midi matches and the
 * detection lands within `tolSec` of the truth note's start. Each truth note
 * and each detection is used at most once (nearest-in-time greedy match).
 */
export function noteSegmentation(detected: DetectedNote[], truth: Note[], tolSec = 0.15): SegmentationResult {
  const usedDet = new Set<number>();
  const latencies: number[] = [];
  let tp = 0;
  for (const t of truth) {
    let best = -1, bestDt = Infinity;
    for (let i = 0; i < detected.length; i++) {
      if (usedDet.has(i)) continue;
      const d = detected[i];
      if (d.midi !== t.midi) continue;
      const dt = Math.abs(d.t - t.start);
      if (dt <= tolSec && dt < bestDt) { best = i; bestDt = dt; }
    }
    if (best >= 0) {
      usedDet.add(best);
      tp++;
      latencies.push(detected[best].t - t.start);
    }
  }
  const fp = detected.length - usedDet.size;
  const fn = truth.length - tp;
  const precision = detected.length > 0 ? tp / detected.length : NaN;
  const recall = truth.length > 0 ? tp / truth.length : NaN;
  const f1 = precision + recall > 0 && !isNaN(precision) && !isNaN(recall) ? (2 * precision * recall) / (precision + recall) : NaN;
  return { precision, recall, f1, truePositives: tp, falsePositives: fp, falseNegatives: fn, latencies };
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
