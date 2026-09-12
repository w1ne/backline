/**
 * Fit side of the real-voice bench: does the band the listener + Patterns engine would play
 * actually fit what the amateur sang? Runs a stitched ~30 s song through the listener with
 * chord ticks at the detected tempo, drives the lofi pattern bank offline over the resulting
 * chord timeline (the way Bandleader.onBar would), and scores the band's notes against the
 * MIR-1K pitch labels. A static-tonic band over the same recording is the baseline.
 */
import { chordName, chordTones, diatonicTriads, tonicTriad } from '../../src/listener/chordDetector';
import { colorChord } from '../../src/music/chordColor';
import { scaleOf } from '../../src/music/scales';
import { PATTERNS } from '../../src/patterns/index';
import { mulberry32 } from '../../src/rng';
import { INSTRUMENTS, type BarContext, type Chord, type Dynamics, type Key } from '../../src/types';
import type { Note } from '../voice/synth';
import type { RunResult } from '../voice/driver';
import type { BandNote } from './midi';

const mod12 = (n: number) => ((n % 12) + 12) % 12;
const PITCHED = new Set(['bass', 'keys', 'lead']);
const HARMONIC = new Set(['bass', 'keys']);
const DISSONANT = new Set([1, 11, 6]);

export interface BandPlan {
  bpm: number;
  /** seconds: the first bar line */
  t0: number;
  key: Key;
  durationSec: number;
  /** plain (uncoloured) chord the listener had in force at time t */
  chordAt: (t: number) => Chord;
  /** the listener's per-beat dynamics; absent = patterns play their static form */
  beats?: RunResult['beats'];
  creativity: number;
  seed: number;
  /** 'mic' when the chord/key came from a singer rather than a MIDI keyboard -- plain triads,
   *  keys kept below the singer's range, and the held note avoided (see chordColor/toolkit). */
  source?: 'midi' | 'mic';
  /** the singer's pitch class at time t (from the labels), or undefined when silent/unstable;
   *  only consulted when `source` is 'mic'. */
  sungPitchClassAt?: (t: number) => number | undefined;
}

/** What Bandleader.onBar does, bar by bar, with absolute seconds instead of a Tone clock. When
 *  `source` is 'mic' each bar is driven in four beat-wide passes so the sung pitch class used
 *  to steer the keys comp (see toolkit.chordPattern) tracks the singer more closely than one
 *  scalar for the whole bar would. */
export function driveBand(plan: BandPlan): BandNote[] {
  const spb = 60 / plan.bpm;
  const barSec = 4 * spb;
  const rng = mulberry32(plan.seed);
  const voicingMemo: Record<string, number[]> = {};
  const out: BandNote[] = [];
  const colour = (c: Chord) => colorChord(c, 'lofi', plan.key, plan.source);
  const dynAt = (t: number): Dynamics | undefined => {
    if (!plan.beats) return undefined;
    let d: Dynamics | undefined;
    for (const b of plan.beats) { if (b.t <= t + 1e-6) d = b.dynamics; else break; }
    return d;
  };
  const mic = plan.source === 'mic';
  // Finer than a half bar: sampling the sung pitch class every beat (rather than every two)
  // catches more of a singer's mid-half-bar moves without changing the per-bar production
  // shape (Bandleader still samples once per bar; this just tightens the bench's estimate).
  for (let bar = 0; ; bar++) {
    const barStart = plan.t0 + bar * barSec;
    if (barStart >= plan.durationSec) break;
    const halves = mic ? [0, 1, 2, 3] : [0];
    for (const half of halves) {
      const ctx: BarContext = {
        bar,
        key: plan.key,
        creativity: plan.creativity,
        rng,
        dynamics: dynAt(barStart),
        chord: colour(plan.chordAt(barStart)),
        chordAt: beat => colour(plan.chordAt(barStart + beat * spb)),
        voicingMemo,
        keysHigh: mic ? 60 : undefined,
        sungPitchClass: mic ? plan.sungPitchClassAt?.(barStart + half * spb) : undefined,
      };
      for (const inst of INSTRUMENTS) {
        for (const e of PATTERNS.lofi[inst].nextBar(ctx)) {
          if (mic && (e.time < half || e.time >= half + 1)) continue;
          const t = barStart + e.time * spb;
          if (t >= plan.durationSec) continue;
          out.push({ inst, t, durSec: e.duration * spb, note: e.note, velocity: e.velocity });
        }
      }
    }
  }
  return out;
}

export interface FitScore {
  /** half bars with at least one voiced label frame */
  halves: number;
  /** frame-weighted share of sung (labelled) pitch in the tones of the chord the band held */
  sungChordToneCoverage: number;
  /** the same, if every half bar had been given the diatonic triad of the label key that covers it best (an upper bound) */
  oracleCoverage: number;
  /** share of band bass/keys/lead notes whose pitch class is in the label-implied key */
  bandInKey: number;
  /** share of half bars where a bass/keys note clashes (m2 or tritone) with a sustained sung note */
  dissonantHalves: number;
  /** half bars that had both a sustained sung note and a bass/keys note */
  scoredHalves: number;
  /** the same clash rate counting only bass notes / only keys notes */
  dissonantBass: number;
  dissonantKeys: number;
  chordChanges: number;
  timeline: string;
}

export function scoreFit(
  plan: BandPlan,
  band: BandNote[],
  labels: { t: number; midi: number }[],
  sungNotes: Note[],
  labelKey: Key,
): FitScore {
  const spb = 60 / plan.bpm;
  const half = 2 * spb;
  const keyScale = scaleOf(labelKey);
  let covered = 0, voiced = 0, halves = 0, dissonant = 0, scored = 0, dissBass = 0, dissKeys = 0, oracle = 0;
  const triads = diatonicTriads(labelKey).map(chordTones);
  let prev = '';
  let changes = 0;
  const timeline: string[] = [];
  for (let h = 0; ; h++) {
    const hs = plan.t0 + h * half, he = hs + half;
    if (hs >= plan.durationSec) break;
    // Chord-tone coverage/timeline are scored against the genre-coloured chord regardless of
    // `source` -- they measure the harmonic fit of the underlying chord the band is thinking
    // in, not what the mic-aware keys voicing actually plays (that's dissonantKeys below).
    const chord = colorChord(plan.chordAt(hs), 'lofi', plan.key);
    const name = chordName(chord);
    if (prev && name !== prev) changes++;
    prev = name;
    if (h % 2 === 0) timeline.push(name);
    const tones = chordTones(chord);
    let v = 0, c = 0;
    const perTriad = triads.map(() => 0);
    for (const l of labels) {
      if (l.t < hs || l.t >= he || l.midi <= 0) continue;
      v++;
      const pc = mod12(Math.round(l.midi));
      if (tones.includes(pc)) c++;
      triads.forEach((t, i) => { if (t.includes(pc)) perTriad[i]++; });
    }
    if (v) { halves++; voiced += v; covered += c; oracle += Math.max(...perTriad); }
    const harm = band.filter(n => HARMONIC.has(n.inst) && n.t >= hs && n.t < he);
    const sung = sungNotes.filter(n => n.end > hs && n.start < he);
    if (harm.length && sung.length) {
      scored++;
      const clashes = (inst?: string) => harm.some(n => (!inst || n.inst === inst) && sung.some(s => s.end > n.t && s.start < n.t + n.durSec && DISSONANT.has(mod12(n.note - s.midi))));
      if (clashes()) dissonant++;
      if (clashes('bass')) dissBass++;
      if (clashes('keys')) dissKeys++;
    }
  }
  const pitched = band.filter(n => PITCHED.has(n.inst));
  const inKey = pitched.filter(n => keyScale.includes(mod12(n.note))).length;
  return {
    halves,
    sungChordToneCoverage: voiced ? covered / voiced : NaN,
    oracleCoverage: voiced ? oracle / voiced : NaN,
    bandInKey: pitched.length ? inKey / pitched.length : NaN,
    dissonantHalves: scored ? dissonant / scored : NaN,
    scoredHalves: scored,
    dissonantBass: scored ? dissBass / scored : NaN,
    dissonantKeys: scored ? dissKeys / scored : NaN,
    chordChanges: changes,
    timeline: timeline.join(' '),
  };
}

/** The chord the listener had in force at t, from the driver's change log, else the key's tonic. */
export function chordTimeline(r: RunResult, key: Key): (t: number) => Chord {
  return (t: number) => {
    let c: Chord | null = null;
    for (const e of r.chords) { if (e.t <= t) c = e.chord; else break; }
    return c ?? tonicTriad(key);
  };
}
