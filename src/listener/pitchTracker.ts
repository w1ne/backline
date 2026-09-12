export interface PitchFrame {
  hz: number;
  clarity: number;
  t: number;
}

export interface StablePitch {
  midi: number;
  cents: number;
  stable: boolean;
}

const centsBetween = (a: number, b: number) => 1200 * Math.log2(a / b);

/**
 * Turns a stream of raw per-frame pitch estimates (one every ~50ms from a
 * continuous analyser poll) into a debounced, octave-safe note reading.
 *
 * A single noisy or octave-doubled frame must not move the reported note: we
 * keep the last 5 frames, correct each towards the current stable octave when
 * it looks like a harmonic/subharmonic of it, then only accept a new pitch
 * when at least 3 of the 5 (post-correction) estimates agree within ±50 cents
 * and clarity clears the gate. The stable pitch itself only moves when the
 * agreed value has actually left it by more than the agreement band, which is
 * the hysteresis that keeps semitone-boundary jitter from flickering.
 */
export class PitchTracker {
  private window: PitchFrame[] = [];
  private stableHz: number | null = null;

  /** Feed one frame (or null for silence/below-floor). Returns the current reading. */
  push(frame: PitchFrame | null): StablePitch | null {
    if (!frame) {
      this.window = [];
      this.stableHz = null;
      return null;
    }

    this.window.push(frame);
    if (this.window.length > 5) this.window.shift();

    const octaveCorrect = (hz: number): number => {
      if (this.stableHz === null) return hz;
      if (Math.abs(centsBetween(hz * 2, this.stableHz)) < 30) return hz * 2;
      if (Math.abs(centsBetween(hz / 2, this.stableHz)) < 30) return hz / 2;
      return hz;
    };

    const hzs = this.window.map(f => octaveCorrect(f.hz));
    const sorted = [...hzs].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const agree = hzs.filter(h => Math.abs(centsBetween(h, median)) <= 50).length;
    const clarityOk = frame.clarity >= 0.85;
    const stable = this.window.length >= 5 && agree >= 3 && clarityOk;

    if (stable && (this.stableHz === null || Math.abs(centsBetween(median, this.stableHz)) > 50)) {
      this.stableHz = median;
    }

    if (this.stableHz === null) return null;
    const midiFloat = 69 + 12 * Math.log2(this.stableHz / 440);
    const midi = Math.round(midiFloat);
    const cents = Math.round((midiFloat - midi) * 100);
    return { midi, cents, stable };
  }
}
