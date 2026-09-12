import type { Key } from '../types';

const MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];

function corr(a: number[], b: number[]): number {
  const ma = a.reduce((s, x) => s + x, 0) / 12;
  const mb = b.reduce((s, x) => s + x, 0) / 12;
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < 12; i++) {
    n += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? n / Math.sqrt(da * db) : 0;
}

/** Every key's Krumhansl correlation with the histogram, best first. */
export function rankKeys(pitchClassWeights: number[]): { key: Key; confidence: number }[] {
  const w = pitchClassWeights;
  const all: { key: Key; confidence: number }[] = [];
  for (let root = 0; root < 12; root++) {
    for (const mode of ['major', 'minor'] as const) {
      const prof = mode === 'major' ? MAJ : MIN;
      const rotated = w.map((_, i) => prof[((i - root) % 12 + 12) % 12]);
      all.push({ key: { root, mode }, confidence: corr(w, rotated) });
    }
  }
  return all.sort((a, b) => b.confidence - a.confidence);
}

export function detectKey(pitchClassWeights: number[]): { key: Key; confidence: number } {
  return rankKeys(pitchClassWeights)[0];
}

/** Share of the histogram's weight that lies on `key`'s scale. */
export function scaleCoverage(pitchClassWeights: number[], key: Key): number {
  const total = pitchClassWeights.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  const scale = key.mode === 'major' ? MAJOR_SCALE : MINOR_SCALE;
  return scale.reduce((a, s) => a + pitchClassWeights[(s + key.root) % 12], 0) / total;
}

const EARLY_NOTES = 5, EARLY_CONFIDENCE = 0.7;
const FULL_NOTES = 8, CONFIDENCE = 0.6;
/** sung seconds needed before the coverage rule may accept a key */
const COVER_MIN_SUSTAIN_SEC = 2;
const COVER_MIN = 0.85, COVER_MARGIN = 0.08;

export class KeyDetector {
  private w = new Array(12).fill(0);
  private count = 0;
  /** seconds of held pitch fed through addSustain */
  private sustained = 0;
  /** the last key either rule accepted; held until another key is accepted */
  private locked: Key | null = null;

  addNote(midi: number, weight = 1): void {
    this.w[((midi % 12) + 12) % 12] += weight;
    this.count++;
  }

  /**
   * A voice's weight is how long it holds a pitch, not how many times it starts one: a real
   * singer slides through a chromatic neighbour on the way to almost every note, and
   * counting those onsets drowns the histogram. Call this per analysis frame with the stable
   * pitch; pair it with `addNote(midi, 0)` on each new note for the minimum-evidence gate.
   */
  addSustain(midi: number, seconds: number): void {
    this.w[((midi % 12) + 12) % 12] += seconds;
    this.sustained += seconds;
  }

  /**
   * The key, once one has been accepted, stays until the evidence accepts a different one: a
   * singer who wanders off the scale for a phrase would otherwise leave the band with no key
   * (one chord) in the middle of the song. On MIR-1K, 10 of the 21 clips that locked had
   * dropped back to null by the end of the clip before this held.
   */
  get key(): Key | null {
    const accepted = this.accept();
    if (accepted) this.locked = accepted;
    return this.locked;
  }

  /**
   * Whether the held key still describes what is being sung: its scale covers most of the
   * held time. A singer whose line is a quarter off any scale has a key for the band to play
   * in, but snapping their pitches onto it would move one note in four.
   */
  get fits(): boolean {
    return this.locked !== null && scaleCoverage(this.w, this.locked) >= COVER_MIN;
  }

  private accept(): Key | null {
    if (this.count < EARLY_NOTES) return null;
    const ranked = rankKeys(this.w);
    const best = ranked[0];
    // Amateur singers sit a median 22 cents off the piano keys, so the Krumhansl correlation
    // rarely reaches 0.6 on a real voice even when everything sung is inside one scale.
    // Once two seconds have been held, a key whose scale covers 85% of the held time and
    // clearly beats the runner-up is accepted on coverage alone. On MIR-1K (bench/realvoice)
    // this locks 21 of 24 clips within 8 s, 12 before, median 2.2 s; the label's own best
    // scale covers 85% of what was sung on only 5 of 24, so "plausible" locks went 2 -> 4.
    // Splitting each frame's pitch between its two neighbouring semitones was measured too
    // and locks fewer (12 of 24), so pitches stay rounded.
    if (
      this.sustained >= COVER_MIN_SUSTAIN_SEC &&
      scaleCoverage(this.w, best.key) >= COVER_MIN &&
      best.confidence - ranked[1].confidence >= COVER_MARGIN
    ) return best.key;
    // A singer gives one note a beat, so waiting for eight is two bars of no harmony. Five
    // notes that fit a profile clearly (0.7) are enough to start on; the usual 0.6 applies
    // from eight. Measured on hummed melodies: lock at 3.0 s instead of 4.4 to 5.7 s, no
    // wrong keys; 0.65 already picks wrong ones.
    const needed = this.count < FULL_NOTES ? EARLY_CONFIDENCE : CONFIDENCE;
    return best.confidence >= needed ? best.key : null;
  }

  reset(): void {
    this.w.fill(0);
    this.count = 0;
    this.sustained = 0;
    this.locked = null;
  }
}
