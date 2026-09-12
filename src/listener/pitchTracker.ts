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

/** consecutive silent/unclear frames (50 ms each) a held note survives */
const MAX_DROPOUT = 2;

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
export interface PitchTrackerOptions {
  /** frames that must be in the window before a reading can be called stable */
  holdFrames: number;
  /** McLeod clarity the newest frame has to clear */
  minClarity: number;
  /** frames (post octave correction) that must agree with the median within ±50 cents */
  minAgree: number;
}

/** Instrument default: 250 ms of agreement and a clean periodicity before a note is trusted. */
export const INSTRUMENT_PROFILE: PitchTrackerOptions = { holdFrames: 5, minClarity: 0.85, minAgree: 3 };
/**
 * Voice profile: humming and singing are breathier (lower clarity) and phrases move
 * faster than a plucked note holds, so 150 ms and two agreeing frames is enough.
 */
export const VOICE_PROFILE: PitchTrackerOptions = { holdFrames: 3, minClarity: 0.7, minAgree: 2 };

export class PitchTracker {
  private window: PitchFrame[] = [];
  private stableHz: number | null = null;
  private dropouts = 0;
  private opts: PitchTrackerOptions;

  constructor(opts: PitchTrackerOptions = INSTRUMENT_PROFILE) {
    this.opts = opts;
  }

  /** Feed one frame (or null for silence/below-floor). Returns the current reading. */
  push(frame: PitchFrame | null): StablePitch | null {
    if (!frame) {
      // A breath, a consonant or one unclear frame must not end the note: hold the
      // reading through short dropouts, let go only after MAX_DROPOUT frames in a row.
      if (this.stableHz !== null && ++this.dropouts <= MAX_DROPOUT) return this.reading(false);
      this.window = [];
      this.stableHz = null;
      this.dropouts = 0;
      return null;
    }
    this.dropouts = 0;

    this.window.push(frame);
    if (this.window.length > this.opts.holdFrames) this.window.shift();

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
    const clarityOk = frame.clarity >= this.opts.minClarity;
    const stable = this.window.length >= this.opts.holdFrames && agree >= this.opts.minAgree && clarityOk;

    if (stable && (this.stableHz === null || Math.abs(centsBetween(median, this.stableHz)) > 50)) {
      this.stableHz = median;
    }

    return this.reading(stable);
  }

  private reading(stable: boolean): StablePitch | null {
    if (this.stableHz === null) return null;
    const midiFloat = 69 + 12 * Math.log2(this.stableHz / 440);
    const midi = Math.round(midiFloat);
    const cents = Math.round((midiFloat - midi) * 100);
    return { midi, cents, stable };
  }
}
