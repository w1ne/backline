import type { BarContext, Chord, NoteEvent, Pattern, Key } from '../types';
import { DRUM } from '../types';
import { pentaOf } from '../music/scales';
import { chordDegreeToMidi, tonicTriad } from '../listener/chordDetector';
import { voiceLead } from '../music/voiceLeading';

export interface Step { t: number; p: number; vel?: number; dur?: number }

/** The chord in force at `beat` of this bar: the live one if the app supplied it, else the
 *  bar's chord, else the key's tonic triad — so a pattern always has something to sit on. */
export const chordAt = (ctx: BarContext, beat: number): Chord =>
  ctx.chordAt?.(beat) ?? ctx.chord ?? tonicTriad(ctx.key);
/** Whether an optional step plays. Creativity is the baseline gate; the effective intensity
 *  in `dynamics` adds on top (never below it), so a fuller band drops fewer optional hits and
 *  a sparse one drops more. Without a listener (`dynamics` absent) only creativity applies. */
export const fires = (s: Step, ctx: BarContext) => {
  if (s.p >= 1) return true;
  const boost = ctx.dynamics ? 0.5 * Math.min(1, Math.max(0, ctx.dynamics.intensity)) : 0;
  return ctx.rng() < s.p + (1 - s.p) * Math.min(1, ctx.creativity + boost);
};

/** How hard the band plays this bar: 0.6 of written velocity when the player is idle, full
 *  when they are going flat out. Without a listener (`dynamics` absent) nothing is scaled. */
export const dynVel = (ctx: BarContext): number =>
  ctx.dynamics ? 0.6 + 0.4 * Math.min(1, Math.max(0, ctx.dynamics.intensity)) : 1;

/** Above this the player is filling the bar themselves, so the keys thin out. */
const THIN_ABOVE = 0.7;

const ev = (time: number, note: number, duration: number, velocity: number, ctx: BarContext): NoteEvent =>
  ({ time, note, duration, velocity: Math.min(1, velocity * dynVel(ctx)) });

export function drumPattern(voices: Partial<Record<keyof typeof DRUM, Step[]>>, fills?: (ctx: BarContext) => NoteEvent[]): Pattern {
  return { nextBar(ctx) {
    const out: NoteEvent[] = [];
    for (const [name, steps] of Object.entries(voices) as [keyof typeof DRUM, Step[]][])
      for (const s of steps) if (fires(s, ctx)) out.push(ev(s.t, DRUM[name], s.dur ?? 0.25, s.vel ?? 0.9, ctx));
    // A fill is a phrase marker: play it whenever the player's activity says one is due,
    // and otherwise keep the old creativity-gated roll at the end of every fourth bar.
    if (fills && (ctx.dynamics?.fillDue || (ctx.bar % 4 === 3 && ctx.rng() < ctx.creativity)))
      out.push(...fills(ctx).map(e => ev(e.time, e.note, e.duration, e.velocity, ctx)));
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
      ev(s.t, chromaticNudge(chordDegreeToMidi(ctx.key, chordAt(ctx, s.t), s.degree, octave), ctx), s.dur ?? 0.5, 0.85, ctx));
  } };
}

/**
 * Comps a chord pattern the way a keys player would: the written `voicings` still decide how
 * many notes ring per hit (its length sets the voice count, 3 for a triad-shaped entry, 4 for
 * a seventh-shaped one) and which bar-to-bar variation is in play, but the actual pitches come
 * from `voiceLead` against the chord active at each hit — so successive hits (and successive
 * bars) move by the smallest total distance rather than jumping to fixed scale-degree offsets.
 * The previous voicing is carried forward via `ctx.voicingMemo[voiceKey]`, explicit state the
 * caller owns (e.g. the bandleader, one memo per its own lifetime) — never a module-level
 * global, so separate pattern instances or test runs never see each other's voicings.
 */
export function chordPattern(voicings: number[][], hits: Step[], octave: number, voiceKey = 'keys'): Pattern {
  const low = 12 * (octave + 1) - 2;
  const high = low + 23;
  return { nextBar(ctx) {
    let i = ctx.bar % voicings.length;
    if (ctx.creativity > 0.5 && ctx.rng() < (ctx.creativity - 0.5)) i = Math.floor(ctx.rng() * voicings.length);
    const voices = voicings[i].length;
    // A busy player already fills the bar; comping every written hit on top of that is what
    // makes a band sound like a backing track. Keep only the ones the pattern insists on.
    const thin = (ctx.dynamics?.intensity ?? 0) > THIN_ABOVE;
    const out: NoteEvent[] = [];
    let prev = ctx.voicingMemo?.[voiceKey] ?? null;
    for (const h of hits) {
      if (thin && h.p < 1) continue;
      if (!fires(h, ctx)) continue;
      // Voiced against the chord at this hit, not at the downbeat, so the second half of a
      // bar follows a chord that changed underneath it.
      const chord = chordAt(ctx, h.t);
      const voicing = voiceLead(prev, chord, { low, high, voices });
      prev = voicing;
      for (const n of voicing) out.push(ev(h.t, n, h.dur ?? 1, h.vel ?? 0.7, ctx));
    }
    if (ctx.voicingMemo && prev) ctx.voicingMemo[voiceKey] = prev;
    return out;
  } };
}

function pentaIdxToMidi(key: Key, idx: number, octave: number) {
  const p = pentaOf(key); const oct = Math.floor(idx / p.length), i = ((idx % p.length) + p.length) % p.length;
  return 12 * (octave + 1 + oct) + p[i];
}

/** The lead answers, it does not talk over the player: with a listener attached it plays only
 *  in the gaps the player leaves (`dynamics.space`) and is silent otherwise. With no listener
 *  (`dynamics` absent) it plays its phrases every bar, as before. */
export function leadPattern(phrases: { t: number; idx: number; p: number; dur?: number }[][], octave: number): Pattern {
  return { nextBar(ctx) {
    if (ctx.dynamics && !ctx.dynamics.space) return [];
    let i = ctx.bar % phrases.length;
    if (ctx.rng() < ctx.creativity * 0.7) i = Math.floor(ctx.rng() * phrases.length);
    const out = phrases[i].filter(s => fires(s, ctx)).map(s => ev(s.t, chromaticNudge(pentaIdxToMidi(ctx.key, s.idx, octave), ctx), s.dur ?? 0.5, 0.8, ctx));
    if (ctx.creativity > 0.3 && ctx.rng() < ctx.creativity) {
      const t = Math.floor(ctx.rng() * 8) / 2, idx = Math.floor(ctx.rng() * 10) - 2;
      out.push(ev(t, pentaIdxToMidi(ctx.key, idx, octave), 0.25, 0.7, ctx));
    }
    return out.sort((a, b) => a.time - b.time);
  } };
}

export const merge = (...ps: Pattern[]): Pattern => ({ nextBar: ctx => ps.flatMap(p => p.nextBar(ctx)) });
