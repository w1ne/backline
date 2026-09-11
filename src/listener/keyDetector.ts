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

export class KeyDetector {
  private w = new Array(12).fill(0);
  private count = 0;

  addNote(midi: number, weight = 1): void {
    this.w[((midi % 12) + 12) % 12] += weight;
    this.count++;
  }

  get key(): Key | null {
    if (this.count < 8) return null;
    const r = detectKey(this.w);
    return r.confidence >= 0.6 ? r.key : null;
  }

  reset(): void {
    this.w.fill(0);
    this.count = 0;
  }
}
