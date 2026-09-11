const MIN = 60, MAX = 180, MIN_ONSETS = 12;

export function estimateTempo(onsets: number[]): { bpm: number; downbeat: number } | null {
  if (onsets.length < MIN_ONSETS) return null;
  const iois: number[] = [];
  for (let i = 1; i < onsets.length; i++) {
    const d = onsets[i] - onsets[i - 1];
    if (d > 0.05) iois.push(d);
  }
  if (iois.length < 4) return null;
  // fold every IOI into the 60–180 bpm window, then histogram at 1 bpm resolution
  const hist = new Map<number, number>();
  for (const d of iois) {
    let bpm = 60 / d;
    while (bpm > MAX) bpm /= 2;
    while (bpm < MIN) bpm *= 2;
    const b = Math.round(bpm);
    hist.set(b, (hist.get(b) ?? 0) + 1);
  }
  // pick the densest ±9 bpm window, return its weighted mean.
  // A ±2 window is too narrow: jittered onsets fold into two adjacent-ish
  // bpm bins (e.g. 92 and 101 for a true 96 bpm with 15ms jitter) that a
  // tight window can't merge, so it locks onto one half instead of the mean.
  const WINDOW = 9;
  let best = 0, bestBpm = 0;
  for (const [b] of hist) {
    let n = 0, sum = 0;
    for (let k = b - WINDOW; k <= b + WINDOW; k++) { const c = hist.get(k) ?? 0; n += c; sum += c * k; }
    if (n > best) { best = n; bestBpm = sum / n; }
  }
  return { bpm: Math.round(bestBpm * 10) / 10, downbeat: onsets[0] };
}

export class TempoLock {
  private onsets: number[] = [];
  private result: { bpm: number; downbeat: number } | null = null;
  push(t: number) {
    if (this.result) return;
    this.onsets.push(t);
    this.result = estimateTempo(this.onsets);
  }
  get locked() { return this.result; }
  reset() { this.onsets = []; this.result = null; }
}
