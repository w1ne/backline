/** A restart: taps more than this far apart start a fresh tap sequence instead of averaging
 * across the gap. */
const RESTART_GAP_SEC = 2;

/**
 * Tap-tempo estimator: feed it wall-clock (or audio-clock) tap times and, once at least
 * three taps have landed within RESTART_GAP_SEC of each other, it reports a bpm/downbeat
 * pair from the median inter-tap interval. The median (not the mean) keeps one fat-fingered
 * tap from skewing the estimate, and is tolerant to the +-15% jitter a human tapping along
 * to a hummed line produces.
 */
export class TapTempo {
  private taps: number[] = [];

  push(tSec: number): { bpm: number; downbeat: number } | null {
    if (this.taps.length && tSec - this.taps[this.taps.length - 1] > RESTART_GAP_SEC) {
      this.taps = [];
    }
    this.taps.push(tSec);
    if (this.taps.length < 3) return null;
    const iois = this.taps.slice(1).map((t, i) => t - this.taps[i]).sort((a, b) => a - b);
    const mid = Math.floor(iois.length / 2);
    const median = iois.length % 2 ? iois[mid] : (iois[mid - 1] + iois[mid]) / 2;
    const bpm = 60 / median;
    return { bpm: Math.round(bpm * 10) / 10, downbeat: this.taps[this.taps.length - 1] };
  }

  reset(): void {
    this.taps = [];
  }
}
