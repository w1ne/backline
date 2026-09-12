import { PitchDetector } from 'pitchy';
import { DEFAULT_TUNING } from './tuning';

/** Below this NSDF peak the frame is noise, whatever the source (DEFAULT_TUNING.pitch.minClarity). */
export const MIN_CLARITY = DEFAULT_TUNING.pitch.minClarity;

/** Voice and the instruments we care about live here; anything outside is a harmonic or rumble. */
const MIN_HZ = 60;
const MAX_HZ = 1200;

/** McLeod's K: the first NSDF peak at least this fraction of the tallest is the pitch. Picking
 *  the tallest peak lands on a harmonic for pure tones; demanding 0.9 skips a slightly
 *  attenuated true fundamental on real voices. 0.8 scored best on the MIR-1K clips
 *  (bench/pitchmodels/pitchy.ts). */
const PEAK_FRACTION = 0.8;

export interface PitchEstimate {
  hz: number;
  /** McLeod NSDF peak value chosen (0..1), how clean the periodicity is. */
  clarity: number;
  /** the value the minClarity gate is applied to; with pitchy this is the chosen peak, which is
   *  at least PEAK_FRACTION of the tallest, so gating on it is the stricter of the two */
  peak: number;
}

/** pitchy preallocates its FFT buffers per input length, so keep one detector per length. */
const detectors = new Map<number, PitchDetector<Float32Array>>();

function detectorFor(n: number): PitchDetector<Float32Array> {
  let d = detectors.get(n);
  if (!d) {
    d = PitchDetector.forFloat32Array(n);
    d.clarityThreshold = PEAK_FRACTION;
    detectors.set(n, d);
  }
  return d;
}

export function detectPitchHz(x: Float32Array, sr: number): number | null {
  return detectPitch(x, sr)?.hz ?? null;
}

/** McLeod pitch method over one analysis window, via the pitchy library (FFT-based NSDF).
 *  Returns null for silence, noise below `minClarity`, or a pitch outside the vocal range.
 *  The PitchTracker applies the per-source clarity gate (0.85 for instruments, 0.7 for a
 *  breathy voice) on top of this. */
export function detectPitch(x: Float32Array, sr: number, minClarity = MIN_CLARITY): PitchEstimate | null {
  const n = x.length;
  let e = 0;
  for (let i = 0; i < n; i++) e += x[i] * x[i];
  if (e / n < 1e-6) return null;
  const [hz, clarity] = detectorFor(n).findPitch(x, sr);
  if (!(hz >= MIN_HZ && hz <= MAX_HZ)) return null;
  if (clarity < minClarity) return null;
  return { hz, clarity, peak: clarity };
}

export const hzToMidi = (hz: number) => Math.round(69 + 12 * Math.log2(hz / 440));
