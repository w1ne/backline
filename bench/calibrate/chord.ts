/**
 * Chord-tuning half of bench/calibrate: grids ChordTuning's melody-harmonizer constants
 * (MELODY_MIN_COVERAGE, MELODY_SWITCH_MARGIN, MELODY_WINDOW_MUL) against two things that
 * already exist as benches of their own: bench/voice/output.ts's chord-in-force accuracy on
 * the arpeggio clip (a single voice outlining a known progression), and bench/realvoice's
 * keys-dissonance on the four real-voice songs (does the mic-aware keys voicing clash with
 * what was actually sung). Both are computed here rather than by importing those run.ts files,
 * since neither exports its per-tuning scoring step; the logic below mirrors them exactly,
 * parameterized by a candidate ListenerTuning instead of the app's default.
 */
import { chordName, chordTones, tonicTriad } from '../../src/listener/chordDetector';
import { detectKey } from '../../src/listener/keyDetector';
import type { ListenerTuning } from '../../src/listener/tuning';
import { VOICE_PROFILE } from '../../src/listener/pitchTracker';
import type { Chord } from '../../src/types';
import { analyse, runClip, type Analysis } from '../voice/driver';
import type { ClipSpec } from '../voice/synth';
import { labelAt, labelNotes, labelPitchClassWeights, type RealClip } from '../realvoice/dataset';
import { chordTimeline, driveBand, scoreFit } from '../realvoice/fit';

const mod12 = (n: number) => ((n % 12) + 12) % 12;

/** The arpeggio clip's chord-in-force accuracy at bar starts, against its known progression
 *  (mirrors bench/voice/output.ts's `accInForce` for one clip). */
export function arpeggioAccuracy(spec: ClipSpec, audio: Float32Array, pre: Analysis, tuning: ListenerTuning): number {
  const bpm = spec.truth.bpm ?? 90;
  const t0 = spec.truth.notes[0].start;
  const r = runClip(audio, VOICE_PROFILE, { bpm, t0 }, tuning, pre);
  const barSec = (60 / bpm) * 4;
  const nBars = Math.ceil((spec.truth.durationSec - t0) / barSec);
  const key = r.key ?? spec.truth.key!;
  const chordAt = (t: number): Chord => {
    let c: Chord | null = null;
    for (const e of r.chords) { if (e.t <= t) c = e.chord; else break; }
    return c ?? tonicTriad(key);
  };
  let hits = 0, n = 0;
  for (let b = 0; b < nBars; b++) {
    const start = t0 + b * barSec, end = start + barSec;
    const sung = spec.truth.notes.filter(note => note.start >= start && note.start < end);
    if (!sung.length) continue;
    const truthChord = spec.truth.chords?.[b];
    if (!truthChord) continue;
    n++;
    if (chordName(chordAt(start)) === chordName(truthChord)) hits++;
  }
  return n ? hits / n : NaN;
}

export interface SongPre {
  song: RealClip;
  pre: Analysis;
  bpm: number;
  t0: number;
}

/** One default-tuning pass per song, cached: tempo/downbeat don't depend on the chord grid. */
export function prepareSong(song: RealClip): SongPre {
  const pre = analyse(song.audio);
  const first = runClip(song.audio, VOICE_PROFILE, undefined, undefined, pre);
  const bpm = first.bpm ?? 90;
  const barSec = (60 / bpm) * 4;
  const downbeat = first.downbeat ?? 0;
  const t0 = downbeat - Math.floor(downbeat / barSec) * barSec;
  return { song, pre, bpm, t0 };
}

/** Keys-dissonance for one song under a candidate tuning (mirrors bench/realvoice/run.ts's `fitRow`). */
export function songDissonantKeys(sp: SongPre, tuning: ListenerTuning): number {
  const r = runClip(sp.song.audio, VOICE_PROFILE, { bpm: sp.bpm, t0: sp.t0 }, tuning, sp.pre);
  const w = labelPitchClassWeights(sp.song.labels);
  const labelKey = detectKey(w).key;
  const key = r.key ?? labelKey;
  const sung = labelNotes(sp.song.labels);
  const sungPitchClassAt = (t: number): number | undefined => {
    const m = labelAt(sp.song.labels, t);
    return m === null ? undefined : mod12(Math.round(m));
  };
  const plan = { bpm: sp.bpm, t0: sp.t0, key, durationSec: sp.song.durationSec, beats: r.beats, creativity: 0.5, seed: 7, source: 'mic' as const, sungPitchClassAt, chordAt: chordTimeline(r, key) };
  const band = driveBand(plan);
  return scoreFit(plan, band, sp.song.labels, sung, labelKey).dissonantKeys;
}
