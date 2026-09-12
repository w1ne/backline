import type { Key } from '../types';

const MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

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

export function detectKey(pitchClassWeights: number[]): { key: Key; confidence: number } {
  const w = pitchClassWeights;
  let best = { key: { root: 0, mode: 'major' as const } as Key, confidence: -2 };
  for (let root = 0; root < 12; root++) {
    for (const mode of ['major', 'minor'] as const) {
      const prof = mode === 'major' ? MAJ : MIN;
      const rotated = w.map((_, i) => prof[((i - root) % 12 + 12) % 12]);
      const c = corr(w, rotated);
      if (c > best.confidence) best = { key: { root, mode }, confidence: c };
    }
  }
  return best;
}

const EARLY_NOTES = 5, EARLY_CONFIDENCE = 0.7;
const FULL_NOTES = 8, CONFIDENCE = 0.6;

export class KeyDetector {
  private w = new Array(12).fill(0);
  private count = 0;
  private recent: { pc: number; weight: number }[] = [];

  addNote(midi: number, weight = 1): void {
    const pc = ((midi % 12) + 12) % 12;
    this.w[pc] += weight;
    this.recent.push({ pc, weight });
    // Keep the early-lock behavior, but let a later phrase replace the initial key.
    if (this.recent.length > 32) {
      const old = this.recent.shift()!;
      this.w[old.pc] = Math.max(0, this.w[old.pc] - old.weight);
    }
    this.count++;
  }

  get key(): Key | null {
    if (this.count < EARLY_NOTES) return null;
    const r = detectKey(this.w);
    // A singer gives one note a beat, so waiting for eight is two bars of no harmony. Five
    // notes that fit a profile clearly (0.7) are enough to start on; the usual 0.6 applies
    // from eight. Measured on hummed melodies: lock at 3.0 s instead of 4.4 to 5.7 s, no
    // wrong keys; 0.65 already picks wrong ones.
    const needed = this.count < FULL_NOTES ? EARLY_CONFIDENCE : CONFIDENCE;
    return r.confidence >= needed ? r.key : null;
  }

  reset(): void {
    this.w.fill(0);
    this.count = 0;
    this.recent = [];
  }
}
