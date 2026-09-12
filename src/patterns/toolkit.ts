import type { BarContext, Chord, NoteEvent, Pattern, Key } from '../types';
import { DRUM } from '../types';
import { pentaOf } from '../music/scales';
import { chordDegreeToMidi, tonicTriad } from '../listener/chordDetector';

export interface Step { t: number; p: number; vel?: number; dur?: number }

/** The chord in force at `beat` of this bar: the live one if the app supplied it, else the
 *  bar's chord, else the key's tonic triad — so a pattern always has something to sit on. */
export const chordAt = (ctx: BarContext, beat: number): Chord =>
  ctx.chordAt?.(beat) ?? ctx.chord ?? tonicTriad(ctx.key);
export const fires = (s: Step, ctx: BarContext) => s.p >= 1 || ctx.rng() < s.p + (1 - s.p) * ctx.creativity;
const ev = (time: number, note: number, duration: number, velocity: number): NoteEvent => ({ time, note, duration, velocity });

export function drumPattern(voices: Partial<Record<keyof typeof DRUM, Step[]>>, fills?: (ctx: BarContext) => NoteEvent[]): Pattern {
  return { nextBar(ctx) {
    const out: NoteEvent[] = [];
    for (const [name, steps] of Object.entries(voices) as [keyof typeof DRUM, Step[]][])
      for (const s of steps) if (fires(s, ctx)) out.push(ev(s.t, DRUM[name], s.dur ?? 0.25, s.vel ?? 0.9));
    if (fills && ctx.bar % 4 === 3 && ctx.rng() < ctx.creativity) out.push(...fills(ctx));
    return out;
  } };
}

function chromaticNudge(note: number, ctx: BarContext) {
  if (ctx.creativity > 0.8 && ctx.rng() < (ctx.creativity - 0.8) * 0.5) return note + (ctx.rng() < 0.5 ? -1 : 1);
  return note;
}

export function bassPattern(shape: { t: number; degree: number; p: number; dur?: number }[], octave: number): Pattern {
  return { nextBar(ctx) {
    return shape.filter(s => fires(s, ctx)).map(s =>
      ev(s.t, chromaticNudge(chordDegreeToMidi(ctx.key, chordAt(ctx, s.t), s.degree, octave), ctx), s.dur ?? 0.5, 0.85));
  } };
}

export function chordPattern(voicings: number[][], hits: Step[], octave: number): Pattern {
  return { nextBar(ctx) {
    let i = ctx.bar % voicings.length;
    if (ctx.creativity > 0.5 && ctx.rng() < (ctx.creativity - 0.5)) i = Math.floor(ctx.rng() * voicings.length);
    const out: NoteEvent[] = [];
    for (const h of hits) {
      if (!fires(h, ctx)) continue;
      // Voiced against the chord at this hit, not at the downbeat, so the second half of a
      // bar follows a chord that changed underneath it.
      const chord = chordAt(ctx, h.t);
      for (const d of voicings[i]) out.push(ev(h.t, chordDegreeToMidi(ctx.key, chord, d, octave), h.dur ?? 1, h.vel ?? 0.7));
    }
    return out;
  } };
}

function pentaIdxToMidi(key: Key, idx: number, octave: number) {
  const p = pentaOf(key); const oct = Math.floor(idx / p.length), i = ((idx % p.length) + p.length) % p.length;
  return 12 * (octave + 1 + oct) + p[i];
}

export function leadPattern(phrases: { t: number; idx: number; p: number; dur?: number }[][], octave: number): Pattern {
  return { nextBar(ctx) {
    let i = ctx.bar % phrases.length;
    if (ctx.rng() < ctx.creativity * 0.7) i = Math.floor(ctx.rng() * phrases.length);
    const out = phrases[i].filter(s => fires(s, ctx)).map(s => ev(s.t, chromaticNudge(pentaIdxToMidi(ctx.key, s.idx, octave), ctx), s.dur ?? 0.5, 0.8));
    if (ctx.creativity > 0.3 && ctx.rng() < ctx.creativity) {
      const t = Math.floor(ctx.rng() * 8) / 2, idx = Math.floor(ctx.rng() * 10) - 2;
      out.push(ev(t, pentaIdxToMidi(ctx.key, idx, octave), 0.25, 0.7));
    }
    return out.sort((a, b) => a.time - b.time);
  } };
}

export const merge = (...ps: Pattern[]): Pattern => ({ nextBar: ctx => ps.flatMap(p => p.nextBar(ctx)) });
