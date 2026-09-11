export class OnsetDetector {
  private prev = 0;
  private last = -Infinity;
  private threshold: number;
  private gap: number;

  constructor(o: { threshold?: number; minGapSec?: number } = {}) {
    this.threshold = o.threshold ?? 0.02;
    this.gap = o.minGapSec ?? 0.1;
  }

  process(frame: Float32Array, t: number): boolean {
    let s = 0;
    for (let i = 0; i < frame.length; i++) s += frame[i] * frame[i];
    const rms = Math.sqrt(s / frame.length);
    const hit = rms > this.threshold && rms > 1.6 * this.prev && t - this.last > this.gap;
    this.prev = rms;
    if (hit) this.last = t;
    return hit;
  }
}
