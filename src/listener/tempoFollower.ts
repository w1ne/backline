import { bpmFromOnsets } from './tempoLock';

/** Tracks the player's tempo smoothly once locked, clamping how fast the band can chase it. */
export class TempoFollower {
  private onsets: number[] = [];
  private bpm: number;
  private window: number;
  private maxStep: number;

  constructor(initialBpm: number, opts: { window?: number; maxStep?: number } = {}) {
    this.bpm = initialBpm;
    this.window = opts.window ?? 8;
    this.maxStep = opts.maxStep ?? 0.08;
  }

  push(t: number): number {
    this.onsets.push(t);
    if (this.onsets.length > this.window) this.onsets.shift();
    if (this.onsets.length < this.window) return this.bpm;

    const est = bpmFromOnsets(this.onsets, this.window);
    if (!est) return this.bpm;

    // fold the estimate to the octave nearest the current tempo
    let b = est.bpm;
    while (b > this.bpm * 1.5) b /= 2;
    while (b < this.bpm / 1.5) b *= 2;

    const lo = this.bpm * (1 - this.maxStep);
    const hi = this.bpm * (1 + this.maxStep);
    this.bpm = Math.min(hi, Math.max(lo, b));
    return this.bpm;
  }
}
