import { Autocorrelator } from 'pitchy';
import { DEFAULT_TUNING } from './tuning';

/** Below this NSDF peak the frame is noise, whatever the source (DEFAULT_TUNING.pitch.minClarity). */
export const MIN_CLARITY = DEFAULT_TUNING.pitch.minClarity;

/** Voice and the instruments we care about live here; anything outside is a harmonic or rumble. */
const MIN_HZ = 60;
const MAX_HZ = 1200;

/** McLeod's K: the first NSDF peak at least this fraction of the tallest in range is the pitch.
 *  Picking the tallest peak lands on a harmonic for pure tones; demanding 0.9 skips a slightly
 *  attenuated true fundamental on real voices (bench/pitchmodels/pitchy.ts). */
const PEAK_FRACTION = 0.8;

export interface PitchEstimate {
  hz: number;
  /** McLeod NSDF peak value chosen (0..1-ish), how clean the periodicity is. */
  clarity: number;
  /** the tallest NSDF peak in range, the value the minClarity gate is applied to */
  peak: number;
}

/** pitchy's FFT autocorrelator preallocates per input length; keep one per length. */
const correlators = new Map<number, { ac: Autocorrelator<Float32Array>; r: Float32Array; nsdf: Float32Array }>();

function correlatorFor(n: number) {
  let c = correlators.get(n);
  if (!c) {
    c = { ac: Autocorrelator.forFloat32Array(n), r: new Float32Array(n), nsdf: new Float32Array(n) };
    correlators.set(n, c);
  }
  return c;
}

/**
 * McLeod pitch method over one analysis window. The autocorrelation comes from pitchy's
 * FFT-based Autocorrelator (the expensive part); the normalised square difference and the
 * peak choice are ours, because pitchy's own findPitch weighs peaks over every lag and a tall
 * sub-harmonic peak below 60 Hz would then make it skip a real low male fundamental.
 * Returns null for silence, noise below `minClarity`, or a pitch outside the vocal range. The
 * PitchTracker applies the per-source clarity gate (0.85 for instruments, 0.7 for a breathy
 * voice) on top of this.
 */
export function detectPitch(x: Float32Array, sr: number, minClarity = MIN_CLARITY): PitchEstimate | null {
  const n = x.length;
  const minLag = Math.floor(sr / MAX_HZ);
  const maxLag = Math.min(Math.floor(sr / MIN_HZ), n - 1);
  let e = 0;
  for (let i = 0; i < n; i++) e += x[i] * x[i];
  if (e / n < 1e-6) return null;

  const { ac, r, nsdf } = correlatorFor(n);
  ac.autocorrelate(x, r);
  // NSDF n'(tau) = 2 r'(tau) / m'(tau), with m'(tau) = sum over the overlap of x_i^2 + x_{i+tau}^2,
  // built incrementally from m'(0) = 2 r'(0) (McLeod & Wyvill, section 6).
  let m = 2 * r[0];
  for (let lag = 0; lag <= maxLag; lag++) {
    nsdf[lag] = m > 0 ? (2 * r[lag]) / m : 0;
    m -= x[lag] * x[lag] + x[n - 1 - lag] * x[n - 1 - lag];
  }

  // Peak selection: after the first negative-going zero crossing, collect all local maxima
  // (parabolically interpolated), then pick the FIRST one at least PEAK_FRACTION of the
  // tallest. This avoids both octave errors: the global max lands on a harmonic for pure
  // tones, and an absolute 0.9 on the first peak skips a slightly attenuated true fundamental.
  let lag = minLag;
  while (lag <= maxLag && nsdf[lag] > 0) lag++;
  const peaks: { lag: number; value: number }[] = [];
  for (; lag < maxLag; lag++) {
    if (nsdf[lag] > nsdf[lag - 1] && nsdf[lag] >= nsdf[lag + 1]) {
      const a = nsdf[lag - 1], b = nsdf[lag], c = nsdf[lag + 1];
      const denom = a - 2 * b + c;
      const shift = denom !== 0 ? (a - c) / (2 * denom) : 0;
      const interpValue = b - (denom !== 0 ? 0.25 * (a - c) * shift : 0);
      peaks.push({ lag: lag + shift, value: interpValue });
    }
  }
  if (peaks.length === 0) return null;
  let max = -Infinity;
  for (const p of peaks) if (p.value > max) max = p.value;
  if (max < minClarity) return null;
  const chosen = peaks.find(p => p.value >= PEAK_FRACTION * max)!;
  return { hz: sr / chosen.lag, clarity: chosen.value, peak: max };
}
