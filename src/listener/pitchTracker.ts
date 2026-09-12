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

/** Debounce raw estimates without folding genuine octave changes into old notes.
 * A median window rejects isolated harmonic errors; sustained changes are accepted.
 */
export interface PitchTrackerOptions {
  /** maximum number of recent confident frames used for agreement */
  holdFrames: number;
  /** McLeod clarity the newest frame has to clear */
  minClarity: number;
  /** frames that must agree with the median within ±50 cents */
  minAgree: number;
}

/** Instruments: three agreeing frames in a five-frame window. */
export const INSTRUMENT_PROFILE: PitchTrackerOptions = { holdFrames: 5, minClarity: 0.85, minAgree: 3 };
/**
 * Voice profile: humming and singing are breathier (lower clarity) and phrases move
 * faster than a plucked note holds, so two agreeing frames in a three-frame window suffice.
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
    if (!frame || !Number.isFinite(frame.hz) || frame.hz <= 0 || !Number.isFinite(frame.clarity) || frame.clarity < this.opts.minClarity) {
      // A breath, a consonant or one unclear frame must not end the note: hold the
      // reading through short dropouts, let go only after MAX_DROPOUT frames in a row.
      if (this.stableHz !== null && ++this.dropouts <= MAX_DROPOUT) return this.reading(true);
      this.window = [];
      this.stableHz = null;
      this.dropouts = 0;
      return null;
    }
    this.dropouts = 0;

    this.window.push(frame);
    if (this.window.length > this.opts.holdFrames) this.window.shift();

    const hzs = this.window.map(f => f.hz);
    const sorted = [...hzs].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const agree = hzs.filter(h => Math.abs(centsBetween(h, median)) <= 50).length;
    const clarityOk = frame.clarity >= this.opts.minClarity;
    const stable = this.window.length >= this.opts.minAgree && agree >= this.opts.minAgree && clarityOk;

    if (stable) {
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
