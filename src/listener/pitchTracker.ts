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

import { DEFAULT_TUNING, type TrackerTuning } from './tuning';

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
export const VOICE_PROFILE: PitchTrackerOptions = DEFAULT_TUNING.voiceProfile;

export class PitchTracker {
  private window: PitchFrame[] = [];
  private stableHz: number | null = null;
  private dropouts = 0;
  /** raw hz of the previous frame, for the glide detector */
  private prevHz: number | null = null;
  /** signed cents moved between the previous two frames */
  private prevDelta = 0;
  /** true while the voice is sliding monotonically; the stable pitch does not move until it settles */
  private gliding = false;
  private opts: PitchTrackerOptions;
  private tuning: TrackerTuning;

  constructor(opts: PitchTrackerOptions = INSTRUMENT_PROFILE, tuning: TrackerTuning = DEFAULT_TUNING.tracker) {
    this.opts = opts;
    this.tuning = tuning;
  }

  /** Feed one frame (or null for silence/below-floor). Returns the current reading. */
  push(frame: PitchFrame | null): StablePitch | null {
    if (!frame || !Number.isFinite(frame.hz) || frame.hz <= 0 || !Number.isFinite(frame.clarity) || frame.clarity < this.opts.minClarity) {
      // A breath, a consonant or one unclear frame must not end the note: hold the
      // reading through short dropouts, let go only after maxDropout frames in a row.
      if (this.stableHz !== null && ++this.dropouts <= this.tuning.maxDropout) return this.reading();
      this.window = [];
      this.stableHz = null;
      this.dropouts = 0;
      this.prevHz = null;
      this.gliding = false;
      return null;
    }
    this.dropouts = 0;

    this.window.push(frame);
    if (this.window.length > this.opts.holdFrames) this.window.shift();

    const hzs = this.window.map(f => f.hz);
    this.trackGlide(hzs[hzs.length - 1]);
    const sorted = [...hzs].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const agree = hzs.filter(h => Math.abs(centsBetween(h, median)) <= 50).length;
    const clarityOk = frame.clarity >= this.opts.minClarity;
    const stable = this.window.length >= this.opts.minAgree && agree >= this.opts.minAgree && clarityOk;

    if (this.gliding && this.stableHz !== null) return this.reading();
    if (stable) {
      this.stableHz = median;
    }

    return this.reading();
  }

  /**
   * A real singer slides between notes and passes through every semitone on the way;
   * each would otherwise become a "stable" note. Two consecutive frames moving the same
   * way by more than glideCents mark a glide, and the stable pitch is frozen until the
   * pitch stops moving: a frame under settledCents, or a reversal of direction (a slide
   * keeps its direction; vibrato turns round every two or three frames, so it is never
   * held as a glide for long). A clean step between two held notes is one big move
   * followed by small ones, so it never counts.
   */
  private trackGlide(hz: number) {
    if (this.prevHz === null) {
      this.prevHz = hz;
      return;
    }
    const delta = centsBetween(hz, this.prevHz);
    this.prevHz = hz;
    const sameWay = Math.sign(delta) === Math.sign(this.prevDelta);
    const { glideCents, settledCents } = this.tuning;
    if (Math.abs(delta) > glideCents && Math.abs(this.prevDelta) > glideCents && sameWay) {
      this.gliding = true;
    } else if (Math.abs(delta) < settledCents || !sameWay) {
      this.gliding = false;
    }
    this.prevDelta = delta;
  }

  /**
   * The reading is the note the tracker currently vouches for. Once a pitch has been
   * accepted it stays stable through a breath, a consonant, a slide or a single unclear
   * frame; the hold ends only when the note is let go (null) or replaced. Reporting those
   * holds as unstable made the listener forget the note and re-trigger it a frame later.
   */
  private reading(): StablePitch | null {
    if (this.stableHz === null) return null;
    const midiFloat = 69 + 12 * Math.log2(this.stableHz / 440);
    const midi = Math.round(midiFloat);
    const cents = Math.round((midiFloat - midi) * 100);
    return { midi, cents, stable: true };
  }
}
