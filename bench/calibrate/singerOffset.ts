/**
 * Singer tuning-offset experiment: does correcting each singer's overall intonation before
 * rounding pitches to semitones, for the key detector only, find more plausible keys without
 * losing correct ones? Estimates a clip's offset from its first 3 s of voiced label frames
 * (median cents from the nearest semitone), subtracts it before rounding every labelled pitch
 * to a pitch class, and replays that corrected pitch-class stream through a fresh KeyDetector
 * — the same mechanism bench/calibrate/run.ts's `replayKey` uses for the app's own tracker
 * output, applied here to the label stream since that's what carries the fractional pitch a
 * correction needs to act on (the tracker itself already rounds before KeyDetector ever sees
 * it, and this bench does not touch pitchTracker.ts or keyDetector.ts).
 *
 * This is a report-only measurement: applying it for real would mean changing what feeds
 * KeyDetector inside the app (pitchTracker.ts / keyDetector.ts), which is out of scope here.
 */
import { KeyDetector } from '../../src/listener/keyDetector';
import { DEFAULT_TUNING } from '../../src/listener/tuning';
import { KEY_PLAUSIBLE_COVERAGE, scaleCoverage } from '../realvoice/metrics';
import type { PitchLabel } from '../realvoice/dataset';
import type { Key } from '../../src/types';

const LABEL_HOP_SEC = 0.02;
const OFFSET_WINDOW_SEC = 3;

/** Median deviation (cents) of the voiced labels in the first `OFFSET_WINDOW_SEC` from the
 *  nearest semitone; 0 when nothing voiced there. */
export function tuningOffsetCents(labels: PitchLabel[]): number {
  const d: number[] = [];
  for (const l of labels) {
    if (l.t > OFFSET_WINDOW_SEC) break;
    if (l.midi > 0) d.push((l.midi - Math.round(l.midi)) * 100);
  }
  if (!d.length) return 0;
  const s = [...d].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export interface OffsetKeyResult {
  lockT: number | null;
  key: Key | null;
  plausible: boolean;
  correct: boolean;
}

/**
 * Replays the labels into a fresh KeyDetector at 20 ms label resolution, rounding each
 * voiced pitch to a semitone after subtracting `offsetCents`, exactly the way
 * bench/calibrate/run.ts's replayKey feeds the tracker's stream.
 */
export function keyWithOffset(labels: PitchLabel[], offsetCents: number, labelKey: Key, weights: number[]): OffsetKeyResult {
  const det = new KeyDetector(DEFAULT_TUNING.key);
  const offsetSemis = offsetCents / 100;
  let lastMidi: number | null = null;
  let lastAt: number | null = null;
  let lockT: number | null = null;
  let last: Key | null = null;
  for (const l of labels) {
    const midi = l.midi > 0 ? Math.round(l.midi - offsetSemis) : null;
    if (midi !== null) {
      if (lastAt !== null) det.addSustain(midi, LABEL_HOP_SEC);
      lastAt = l.t;
      if (midi !== lastMidi) { lastMidi = midi; det.addNote(midi, 0); }
    } else {
      lastMidi = null;
      lastAt = null;
    }
    last = det.key;
    if (lockT === null && last !== null) lockT = l.t;
  }
  const cov = last ? scaleCoverage(weights, last) : NaN;
  return {
    lockT,
    key: last,
    plausible: last !== null && cov >= KEY_PLAUSIBLE_COVERAGE,
    correct: last !== null && last.root === labelKey.root && last.mode === labelKey.mode,
  };
}
