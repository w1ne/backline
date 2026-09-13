import { mulberry32 } from '../rng';
import type { Arrangement, BarContext, Instrument, NoteEvent, Pattern } from '../types';
import { DRUM } from '../types';
import { chordDegreeToMidi, chordScale } from '../music/chords';
import { chordAt } from './toolkit';

/** Where a bar sits in the song's 4-bar phrase / 8-bar section structure. Pure function of
 *  the bar number so it needs no state carried across calls. */
export interface PhrasePosition { barInPhrase: number; isPhraseEnd: boolean; isSectionEnd: boolean; sectionIndex: number }
export function phrasePosition(bar: number): PhrasePosition {
  const barInPhrase = ((bar % 4) + 4) % 4;
  const sectionIndex = Math.floor(bar / 8);
  return { barInPhrase, isPhraseEnd: barInPhrase === 3, isSectionEnd: (((bar % 8) + 8) % 8) === 7, sectionIndex };
}

/** A cheap, stateless proxy for "what would this bar's pick have been" — used only to keep
 *  adjacent-bar template choices from repeating too often, without carrying state across
 *  `nextBar` calls (which must stay allocation-light and stateless). */
function seededUnit(n: number): number {
  return mulberry32((n * 2654435761) >>> 0)();
}

/** Picks among `numTemplates` alternative bar shapes for an instrument. Template 0 is always
 *  today's fixed pattern. At creativity 0 it is always chosen (bit-for-bit backward
 *  compatible); at creativity 1 every template is chosen with equal probability. To avoid
 *  the same non-zero template three bars running, a synthetic (stateless) history check
 *  forces back to template 0 when it would repeat a third time. */
export function pickTemplate(ctx: BarContext, numTemplates: number): number {
  if (numTemplates <= 1 || ctx.creativity <= 0) return 0;
  const idx = ctx.rng() < ctx.creativity ? Math.floor(ctx.rng() * numTemplates) : 0;
  if (idx === 0) return 0;
  const proxyPick = (bar: number): number => {
    if (bar < 0) return 0;
    const roll = seededUnit(bar * 7 + 1);
    if (roll >= ctx.creativity) return 0;
    return Math.floor(seededUnit(bar * 7 + 2) * numTemplates);
  };
  const prev1 = proxyPick(ctx.bar - 1), prev2 = proxyPick(ctx.bar - 2);
  if (idx === prev1 && idx === prev2) return 0;
  return idx;
}

/** Extra fill events layered on top of a genre's written fill on phrase-end bars (bar 4 of
 *  every 4-bar phrase). Grows with creativity and the player's intensity; bigger on the
 *  8-bar section boundary. Independent of the toolkit's own `dynamics.fillDue` gate. */
export function phraseFill(ctx: BarContext): NoteEvent[] {
  const pos = phrasePosition(ctx.bar);
  if (!pos.isPhraseEnd || ctx.creativity <= 0) return [];
  const intensity = ctx.dynamics ? Math.min(1, Math.max(0, ctx.dynamics.intensity)) : 0.5;
  const weight = ctx.creativity * (0.5 + 0.5 * intensity) * (pos.isSectionEnd ? 1.6 : 1);
  const slots = [3.25, 3.375, 3.5, 3.625, 3.75, 3.875];
  const out: NoteEvent[] = [];
  for (const t of slots) if (ctx.rng() < weight) out.push({ time: t, note: DRUM.snare, duration: 0.125, velocity: 0.55 + 0.3 * weight });
  return out;
}

/** A crash on the downbeat of the bar right after a phrase-end fill (bars whose barInPhrase
 *  is 0, other than bar 0 of a fresh section). */
export function crashAfterFill(ctx: BarContext): NoteEvent[] {
  const pos = phrasePosition(ctx.bar);
  if (pos.barInPhrase !== 0 || ctx.bar === 0 || ctx.creativity <= 0) return [];
  return [{ time: 0, note: DRUM.crash, duration: 0.5, velocity: 0.6 + 0.3 * ctx.creativity }];
}

/** Ride vs hat: alternates every 8-bar section so a tune doesn't sit on the same cymbal for
 *  its whole length. */
export function useRideThisSection(ctx: BarContext): boolean {
  return ctx.creativity > 0 && phrasePosition(ctx.bar).sectionIndex % 2 === 1;
}

/** A chromatic-or-scale-step approach note into the *next* bar's chord, played on the last
 *  eighth of this bar (t=3.5). Looks at beat 4 of the current bar via `ctx.chordAt` — the
 *  best proxy available for "what's coming" without a lookahead API — and falls back to the
 *  current chord when nothing new is known, so the fallback is silent (no motion). */
export function bassApproachNote(ctx: BarContext, octave: number): NoteEvent[] {
  if (ctx.creativity <= 0) return [];
  const nowChord = chordAt(ctx, 3.5);
  const nextChord = chordAt(ctx, 4);
  if (nowChord.root === nextChord.root && nowChord.quality === nextChord.quality) return [];
  if (ctx.rng() >= Math.min(1, ctx.creativity + 0.3)) return [];
  const target = chordDegreeToMidi(ctx.key, nextChord, 0, octave);
  const below = ctx.rng() < 0.5 ? target - 1 : target - 2;
  return [{ time: 3.75, note: below, duration: 0.25, velocity: 0.75 }];
}

/** A short 2-4 note answer phrase for lead/keys, played from the chord's scale, only when the
 *  player has left space and creativity calls for it. */
export function spaceAnswerPhrase(ctx: BarContext, octave: number): NoteEvent[] {
  if (!ctx.dynamics?.space || ctx.creativity <= 0) return [];
  if (ctx.rng() >= ctx.creativity) return [];
  const chord = chordAt(ctx, 2);
  const scale = chordScale(ctx.key, chord);
  const n = 2 + Math.floor(ctx.rng() * 3); // 2..4 notes
  const start = 2.25;
  const out: NoteEvent[] = [];
  for (let i = 0; i < n; i++) {
    const degIdx = Math.floor(ctx.rng() * scale.length);
    const note = 12 * (octave + 1) + chord.root + scale[degIdx];
    out.push({ time: start + i * 0.25, note, duration: 0.2, velocity: 0.5 });
  }
  return out;
}

/** Ghost snares (very quiet) on the "e" and "a" subdivisions, added only when the player is
 *  digging in hard. */
export function ghostSnares(ctx: BarContext): NoteEvent[] {
  const intensity = ctx.dynamics?.intensity ?? 0;
  if (intensity <= 0.8) return [];
  const out: NoteEvent[] = [];
  for (const beat of [0, 1, 2, 3]) {
    if (ctx.rng() < 0.5) out.push({ time: beat + 0.25, note: DRUM.snare, duration: 0.1, velocity: 0.3 }); // "e"
    if (ctx.rng() < 0.5) out.push({ time: beat + 0.75, note: DRUM.snare, duration: 0.1, velocity: 0.3 }); // "a"
  }
  return out;
}

/** When the player is idle (low intensity) the kick pulls back to just beats 1 and 3, and any
 *  drum event on the off-beat 8th grid gets thinned out. Filters an already-built bar. */
export function thinForLowIntensity(events: NoteEvent[], ctx: BarContext): NoteEvent[] {
  const intensity = ctx.dynamics?.intensity ?? 1;
  if (intensity >= 0.3) return events;
  return events.filter(e => {
    if (e.note === DRUM.kick) return e.time === 0 || e.time === 2;
    if (e.note === DRUM.hat || e.note === DRUM.openHat) return e.time % 1 === 0; // keep quarters only
    return true;
  });
}

/** Picks one of several pre-built Patterns for a bar (see `pickTemplate`), rather than
 *  rebuilding steps per bar — keeps selection allocation-light. Template index 0 must be the
 *  instrument's original, unchanged pattern so creativity 0 stays bit-for-bit identical. */
export function chooseTemplate(patterns: Pattern[]): Pattern {
  return { nextBar(ctx) { return patterns[pickTemplate(ctx, patterns.length)].nextBar(ctx); } };
}

/** Layers phrase-level drum phrasing (extra fill hits, the crash after a fill, ride/hat
 *  section switch, ghost snares, low-intensity thinning) on top of a base drum Pattern. */
export function withDrumPhrasing(pattern: Pattern): Pattern {
  return { nextBar(ctx) {
    let out = pattern.nextBar(ctx).concat(phraseFill(ctx), crashAfterFill(ctx));
    if (useRideThisSection(ctx)) out = out.map(e => (e.note === DRUM.hat ? { ...e, note: DRUM.openHat } : e));
    out = out.concat(ghostSnares(ctx));
    return thinForLowIntensity(out, ctx);
  } };
}

/** Adds a chromatic/scale-step approach note into the next bar's chord on top of a base bass
 *  Pattern. */
export function withBassApproach(pattern: Pattern, octave: number): Pattern {
  return { nextBar(ctx) { return pattern.nextBar(ctx).concat(bassApproachNote(ctx, octave)); } };
}

/** Adds a short answering phrase (from the chord scale) when the player leaves space, on top
 *  of a base keys/lead Pattern. */
export function withSpaceAnswer(pattern: Pattern, octave: number): Pattern {
  return { nextBar(ctx) { return pattern.nextBar(ctx).concat(spaceAnswerPhrase(ctx, octave)); } };
}

/** Collapses a bar's events into a single held note (or chord, for drums) starting at beat 0
 *  and lasting the whole bar — a pad/sustain, used for intro keys and breakdown keys. Picks
 *  from whatever already fired on the downbeat (in key/chord already, since it came out of
 *  the pattern), falling back to the bar's first event so a bar with nothing on beat 0 still
 *  sustains something. */
function sustainWholeBar(events: NoteEvent[]): NoteEvent[] {
  if (!events.length) return events;
  const onDownbeat = events.filter(e => e.time === 0);
  const base = onDownbeat.length ? onDownbeat : [events[0]];
  return base.map(e => ({ ...e, time: 0, duration: 4 }));
}

/** Intro: drums drop to hats only, bass to its root hit, keys become a pad, lead sits out. */
function introArrangement(inst: Instrument, events: NoteEvent[]): NoteEvent[] {
  if (inst === 'drums') return events.filter(e => e.note === DRUM.hat || e.note === DRUM.openHat);
  if (inst === 'bass') return events.filter(e => e.time === 0);
  if (inst === 'keys') return sustainWholeBar(events);
  if (inst === 'lead') return [];
  return events;
}

/** Breakdown: drums drop to kick + hat, keys sustain; bass and lead are left to the genre's
 *  own low-intensity behavior (toolkit.ts already thins them). */
function breakdownArrangement(inst: Instrument, events: NoteEvent[]): NoteEvent[] {
  if (inst === 'drums') return events.filter(e => e.note === DRUM.kick || e.note === DRUM.hat);
  if (inst === 'keys') return sustainWholeBar(events);
  return events;
}

/** Lift: drums get a crash on the downbeat (if the bar didn't already earn one). Lead being
 *  "allowed" during a lift is otherwise the genre's own dynamics.space gate — see
 *  genreContract's "lead sits out while playing" rule, which a lift doesn't override, since
 *  this helper has no chord/key to write new lead notes with. */
function liftArrangement(inst: Instrument, events: NoteEvent[]): NoteEvent[] {
  if (inst !== 'drums' || events.some(e => e.note === DRUM.crash)) return events;
  return events.concat([{ time: 0, note: DRUM.crash, duration: 0.5, velocity: 0.85 }]);
}

/** Ending: every enabled instrument plays one long note (or chord, for drums) starting on
 *  beat 1, then the band stops itself (see SongForm.shouldStop). Built from whatever the
 *  underlying pattern already produced for the downbeat so it stays in key/chord, stretched
 *  to fill the bar. */
function endingArrangement(inst: Instrument, events: NoteEvent[]): NoteEvent[] {
  if (inst === 'drums') {
    const onDownbeat = events.filter(e => e.time === 0);
    const notes = [...new Set((onDownbeat.length ? onDownbeat : events.slice(0, 1)).map(e => e.note))];
    if (!notes.length) notes.push(DRUM.kick);
    return notes.map(note => ({ time: 0, note, duration: 4, velocity: 0.95 }));
  }
  const source = events.find(e => e.time === 0) ?? events[0];
  if (!source) return [];
  return [{ ...source, time: 0, duration: 4, velocity: Math.min(1, source.velocity + 0.2) }];
}

/** Applies the song's current arrangement (see SongForm / BarContext.arrangement) to one
 *  instrument's already-generated bar. No arrangement (or an ordinary groove bar) passes
 *  the events through unchanged, so genre patterns without a listener/form are unaffected. */
export function applyArrangement(inst: Instrument, events: NoteEvent[], arrangement?: Arrangement): NoteEvent[] {
  if (!arrangement) return events;
  if (arrangement.ending) return endingArrangement(inst, events);
  if (arrangement.intro) return introArrangement(inst, events);
  if (arrangement.breakdown) return breakdownArrangement(inst, events);
  if (arrangement.lift) return liftArrangement(inst, events);
  return events;
}

/** Wraps a Pattern so every bar it produces is passed through {@link applyArrangement} for
 *  `inst`, reading the arrangement off the BarContext the caller already builds. The one-line
 *  change each genre file needs to pick up song form. */
export function withArrangement(inst: Instrument, pattern: Pattern): Pattern {
  return { nextBar(ctx) { return applyArrangement(inst, pattern.nextBar(ctx), ctx.arrangement); } };
}
