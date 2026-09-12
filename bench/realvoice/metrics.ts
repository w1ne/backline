/**
 * Metrics that need the MIR-1K frame labels rather than synthetic note lists. Note
 * segmentation and medians are reused from bench/voice/metrics.ts.
 */
import type { RawFrame } from '../voice/driver';
import { FFT_SIZE, HOP_SIZE, magnitudeSpectrum } from '../../src/listener/fft';
import { SR } from '../voice/synth';
import { scaleOf } from '../../src/music/scales';
import type { Key } from '../../src/types';
import { labelAt, type PitchLabel } from './dataset';

/** The pitch window is 4096 samples ending one hop after the frame's stamp; this is its centre. */
const PITCH_WINDOW = 4096;
const WINDOW_CENTRE_OFFSET = (HOP_SIZE - PITCH_WINDOW / 2) / SR;

const midiToHz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

export interface LabelPitchAccuracy {
  voicedFrames: number;
  accuratePct: number;
  octaveErrorPct: number;
  /** voiced label frames where the detector returned nothing at all */
  silentPct: number;
  /** of the frames that were neither accurate nor octave errors nor silent */
  otherErrorPct: number;
}

/** Raw McLeod estimate vs the labelled pitch, on frames the label marks voiced. */
export function labelPitchAccuracy(frames: RawFrame[], labels: PitchLabel[]): LabelPitchAccuracy {
  let voiced = 0, accurate = 0, octave = 0, silent = 0;
  for (const f of frames) {
    const truth = labelAt(labels, f.t + WINDOW_CENTRE_OFFSET);
    if (truth === null) continue;
    voiced++;
    if (f.hz === null) { silent++; continue; }
    const cents = 1200 * Math.log2(f.hz / midiToHz(truth));
    if (Math.abs(cents) <= 50) accurate++;
    else if (Math.abs(Math.abs(cents) - 1200) <= 50) octave++;
  }
  const pct = (n: number) => (voiced ? (100 * n) / voiced : NaN);
  return {
    voicedFrames: voiced,
    accuratePct: pct(accurate),
    octaveErrorPct: pct(octave),
    silentPct: pct(silent),
    otherErrorPct: pct(voiced - accurate - octave - silent),
  };
}

/** Share of the duration-weighted sung pitch classes that lie in `key`'s scale. */
export function scaleCoverage(weights: number[], key: Key): number {
  const total = weights.reduce((a, b) => a + b, 0);
  if (!total) return NaN;
  const sc = scaleOf(key);
  return sc.reduce((a, pc) => a + weights[pc], 0) / total;
}

export const KEY_PLAUSIBLE_COVERAGE = 0.85;

/** The scale (of the 24 major/minor ones) that covers the most of the sung pitch classes. */
export function bestCoveringKey(weights: number[]): { key: Key; coverage: number } {
  let best: { key: Key; coverage: number } = { key: { root: 0, mode: 'major' }, coverage: -1 };
  for (let root = 0; root < 12; root++) for (const mode of ['major', 'minor'] as const) {
    const key: Key = { root, mode };
    const c = scaleCoverage(weights, key);
    if (c > best.coverage) best = { key, coverage: c };
  }
  return best;
}

export interface Intonation {
  /** median distance of the labelled pitch from the nearest semitone, in cents */
  medianCents: number;
  /** share of voiced label frames more than 30 cents from any semitone */
  offPct: number;
}

/** How far the singer sits from the piano keys: the labels are fractional semitones. */
export function intonation(labels: PitchLabel[]): Intonation {
  const d: number[] = [];
  for (const l of labels) if (l.midi > 0) d.push(Math.abs(l.midi - Math.round(l.midi)) * 100);
  if (!d.length) return { medianCents: NaN, offPct: NaN };
  const s = [...d].sort((a, b) => a - b);
  return { medianCents: s[Math.floor(s.length / 2)], offPct: (100 * d.filter(x => x > 30).length) / d.length };
}

/**
 * Tempo of the karaoke accompaniment the singer was following, from the autocorrelation of
 * its spectral-flux onset envelope over 60-180 bpm. A rough reference, not a label: the
 * accompaniment is a synthetic backing track, so its beat is usually clear.
 */
export function accompanimentTempo(audio: Float32Array): number | null {
  const nHops = Math.floor(audio.length / HOP_SIZE);
  if (nHops < 200) return null;
  const flux = new Float32Array(nHops);
  let prev: Float32Array | null = null;
  const frame = new Float32Array(FFT_SIZE);
  for (let h = 0; h < nHops; h++) {
    const start = h * HOP_SIZE + HOP_SIZE - FFT_SIZE;
    for (let i = 0; i < FFT_SIZE; i++) frame[i] = start + i >= 0 && start + i < audio.length ? audio[start + i] : 0;
    const mag = magnitudeSpectrum(frame);
    if (prev) { let f = 0; for (let i = 0; i < mag.length; i++) f += Math.max(0, mag[i] - prev[i]); flux[h] = f; }
    prev = Float32Array.from(mag);
  }
  const mean = flux.reduce((a, b) => a + b, 0) / nHops;
  for (let i = 0; i < nHops; i++) flux[i] -= mean;
  const hopSec = HOP_SIZE / SR;
  const minLag = Math.round((60 / 180) / hopSec), maxLag = Math.round((60 / 60) / hopSec);
  let bestLag = -1, best = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let r = 0;
    for (let i = lag; i < nHops; i++) r += flux[i] * flux[i - lag];
    r /= nHops - lag;
    if (r > best) { best = r; bestLag = lag; }
  }
  return bestLag > 0 ? 60 / (bestLag * hopSec) : null;
}
