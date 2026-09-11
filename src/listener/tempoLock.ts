const MIN = 60, MAX = 180, MIN_ONSETS = 12;

export function estimateTempo(onsets: number[]): { bpm: number; downbeat: number } | null {
  return bpmFromOnsets(onsets, MIN_ONSETS);
}

export function bpmFromOnsets(onsets: number[], minOnsets: number): { bpm: number; downbeat: number } | null {
  if (onsets.length < minOnsets) return null;
  const iois: number[] = [];
  for (let i = 1; i < onsets.length; i++) {
    const d = onsets[i] - onsets[i - 1];
    if (d > 0.05) iois.push(d);
  }
  if (iois.length < 4) return null;
  // fold every IOI into the 60–180 bpm window, tracking each one's folded
  // period alongside its rounded bpm (used for the stage-2 refinement below)
  const folded: { period: number; bpm: number }[] = [];
  const hist = new Map<number, number>();
  for (const d of iois) {
    let period = d;
    let bpm = 60 / period;
    while (bpm > MAX) { bpm /= 2; period *= 2; }
    while (bpm < MIN) { bpm *= 2; period /= 2; }
    const b = Math.round(bpm);
    folded.push({ period, bpm: b });
    hist.set(b, (hist.get(b) ?? 0) + 1);
  }
  // Stage 1: find the mode with a window proportional to the candidate bpm
  // (±5%), so nearby-but-distinct tempos (e.g. 100 vs 110) stay separate
  // while jitter that spreads across a few bpm still gets grouped.
  let bestCount = 0, modeBpm = 0;
  for (const [b] of hist) {
    const w = b * 0.05;
    let n = 0;
    for (const [k, c] of hist) { if (Math.abs(k - b) <= w) n += c; }
    if (n > bestCount) { bestCount = n; modeBpm = b; }
  }
  // Stage 2: refine in IOI space, where jitter is symmetric — average the
  // actual periods (not their rounded bpm) of every folded IOI within ±12%
  // of the mode's period, then convert back to bpm. The anchor here is the
  // rounded mode bpm, i.e. one edge of the jittered split rather than its
  // true center, so the window has to cover the full split width (up to
  // ~4*jitter/period) as seen from that edge, not just half of it.
  const modePeriod = 60 / modeBpm;
  const near = folded.filter(f => Math.abs(f.period - modePeriod) <= modePeriod * 0.12);
  const meanPeriod = near.reduce((s, f) => s + f.period, 0) / near.length;
  const bpm = 60 / meanPeriod;
  return { bpm: Math.round(bpm * 10) / 10, downbeat: onsets[0] };
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
