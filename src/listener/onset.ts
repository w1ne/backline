export class OnsetDetector {
  private prev = 0;
  private last = -Infinity;
  private floor = 0;
  private minThreshold: number;
  private gap: number;
  private readonly floorAlpha = 0.02;

  constructor(o: { threshold?: number; minGapSec?: number } = {}) {
    this.minThreshold = o.threshold ?? 0.004;
    this.gap = o.minGapSec ?? 0.1;
  }

  process(frame: Float32Array, t: number): boolean {
    let s = 0;
    for (let i = 0; i < frame.length; i++) s += frame[i] * frame[i];
    const rms = Math.sqrt(s / frame.length);
    const dynamicThreshold = Math.max(this.minThreshold, 3 * this.floor);
    const hit = rms > dynamicThreshold && rms > 1.4 * this.prev && t - this.last > this.gap;
    if (!hit) {
      this.floor = this.floor + this.floorAlpha * (rms - this.floor);
    }
    this.prev = rms;
    if (hit) this.last = t;
    return hit;
  }
}
