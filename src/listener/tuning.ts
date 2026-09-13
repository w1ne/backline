/**
 * Every listener constant that bench/calibrate searches over, in one object. The classes
 * take the relevant slice optionally and fall back to DEFAULT_TUNING, so the app never
 * passes anything; the benches pass candidates. Values here are the ones the app ships.
 */

/** detectPitch (src/listener/pitch.ts) */
export interface PitchTuning {
  /** below this NSDF peak the frame is noise, whatever the source */
  minClarity: number;
}

/** PitchTracker (src/listener/pitchTracker.ts), independent of the instrument/voice profile */
export interface TrackerTuning {
  /** consecutive silent/unclear frames (50 ms each) a held note survives */
  maxDropout: number;
  /** frame-to-frame movement (cents) that counts as still sliding, when it keeps one direction */
  glideCents: number;
  /** frame-to-frame movement (cents) small enough to count as settled */
  settledCents: number;
}

/** PitchTracker profile the mic uses (VOICE_PROFILE) */
export interface VoiceProfileTuning {
  /** frames that must be in the window before a reading can be called stable */
  holdFrames: number;
  /** McLeod clarity the newest frame has to clear */
  minClarity: number;
  /** frames (post octave correction) that must agree with the median within ±50 cents */
  minAgree: number;
}

/** KeyDetector (src/listener/keyDetector.ts) */
export interface KeyTuning {
  /** distinct notes needed before any key may be reported */
  earlyNotes: number;
  /** Krumhansl correlation needed between earlyNotes and fullNotes */
  earlyConfidence: number;
  /** notes from which the ordinary confidence applies */
  fullNotes: number;
  /** Krumhansl correlation needed from fullNotes on */
  confidence: number;
  /** sung seconds needed before the coverage rule may accept a key */
  coverMinSustainSec: number;
  /** share of the held time a scale must cover to be accepted on coverage, and to keep snapping onto */
  coverMin: number;
  /** correlation lead over the runner-up the coverage rule needs */
  coverMargin: number;
}

/** OnsetDetector (src/listener/onset.ts) */
export interface OnsetTuning {
  /** threshold = median × mult + delta */
  mult: number;
  delta: number;
  /** quantile of the flux history the threshold is built on */
  quantile: number;
}

/** ChordDetector melody path (src/listener/chordDetector.ts) */
export interface ChordTuning {
  /** a pitch class must carry this share of the window's energy to count as a chord tone somebody played */
  templateMinShare: number;
  /** harmonizer memory as a multiple of the chord window (two beats) */
  melodyWindowMul: number;
  /** a rival must cover this much more of the sung energy than the held chord to replace it */
  melodySwitchMargin: number;
  /** below this coverage no diatonic triad explains the melody; the held chord (or tonic) stays */
  melodyMinCoverage: number;
}

export interface ListenerTuning {
  pitch: PitchTuning;
  tracker: TrackerTuning;
  voiceProfile: VoiceProfileTuning;
  key: KeyTuning;
  chord: ChordTuning;
  onset: OnsetTuning;
}

export const DEFAULT_TUNING: ListenerTuning = {
  pitch: { minClarity: 0.6 },
  tracker: { maxDropout: 2, glideCents: 35, settledCents: 20 },
  voiceProfile: { holdFrames: 3, minClarity: 0.7, minAgree: 2 },
  key: { earlyNotes: 5, earlyConfidence: 0.7, fullNotes: 8, confidence: 0.6, coverMinSustainSec: 2, coverMin: 0.85, coverMargin: 0.08 },
  chord: { templateMinShare: 0.1, melodyWindowMul: 1.5, melodySwitchMargin: 0.15, melodyMinCoverage: 0.5 },
  onset: { mult: 2.5, delta: 0.12, quantile: 0.75 },
};

/** DEFAULT_TUNING with some slices replaced; nested objects are replaced whole. */
export function withTuning(over: Partial<ListenerTuning>, base: ListenerTuning = DEFAULT_TUNING): ListenerTuning {
  return { ...base, ...over };
}
