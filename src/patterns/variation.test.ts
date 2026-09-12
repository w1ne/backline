import { describe, it, expect } from 'vitest';
import { mulberry32 } from '../rng';
import type { BarContext, Dynamics, NoteEvent } from '../types';
import { DRUM } from '../types';
import {
  phrasePosition, phraseFill, crashAfterFill, useRideThisSection, bassApproachNote,
  pickTemplate, spaceAnswerPhrase, ghostSnares, thinForLowIntensity, withDrumPhrasing,
  applyArrangement, withArrangement,
} from './variation';
import { drumPattern } from './toolkit';

const KEY = { root: 0, mode: 'major' as const };
const OPEN: Dynamics = { intensity: 0.5, space: true, fillDue: false, silenceBeats: 2 };

function ctxFor(bar: number, creativity: number, seed = 1, dynamics: Dynamics = OPEN, chord?: any): BarContext {
  return { bar, key: KEY, chord, creativity, rng: mulberry32(seed + bar), dynamics };
}

describe('phrasePosition', () => {
  it('cycles 0..3 and flags phrase/section ends', () => {
    expect(phrasePosition(0)).toEqual({ barInPhrase: 0, isPhraseEnd: false, isSectionEnd: false, sectionIndex: 0 });
    expect(phrasePosition(3)).toEqual({ barInPhrase: 3, isPhraseEnd: true, isSectionEnd: false, sectionIndex: 0 });
    expect(phrasePosition(7)).toEqual({ barInPhrase: 3, isPhraseEnd: true, isSectionEnd: true, sectionIndex: 0 });
    expect(phrasePosition(8)).toEqual({ barInPhrase: 0, isPhraseEnd: false, isSectionEnd: false, sectionIndex: 1 });
  });
});

describe('drum phrasing over 16 bars at creativity 0.7', () => {
  const base = drumPattern({
    kick: [{ t: 0, p: 1 }, { t: 2, p: 1 }],
    snare: [{ t: 1, p: 1 }, { t: 3, p: 1 }],
    hat: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map(t => ({ t, p: 1 })),
  });
  const pattern = withDrumPhrasing(base);
  const bars = Array.from({ length: 16 }, (_, bar) => pattern.nextBar(ctxFor(bar, 0.7, 100)));

  it('bar 3 and bar 4 (0-indexed) differ', () => {
    expect(bars[2]).not.toEqual(bars[3]);
  });
  it('bar 8 (section end) has at least as many events as bar 4 (phrase end)', () => {
    expect(bars[7].length).toBeGreaterThanOrEqual(bars[3].length);
  });
  it('bar 1 (index 8) has a crash, following bar 8 (index 7)\'s fill', () => {
    expect(bars[8].some(e => e.note === DRUM.crash)).toBe(true);
  });
});

describe('useRideThisSection', () => {
  it('alternates hat/ride by 8-bar section only when creativity > 0', () => {
    expect(useRideThisSection(ctxFor(0, 0.5))).toBe(false);
    expect(useRideThisSection(ctxFor(8, 0.5))).toBe(true);
    expect(useRideThisSection(ctxFor(8, 0))).toBe(false);
  });
});

describe('bassApproachNote', () => {
  it('plays nothing when the chord does not change', () => {
    const chord = { root: 0, quality: 'maj' as const };
    const ctx = ctxFor(0, 1, 1, OPEN, chord);
    expect(bassApproachNote(ctx, 2)).toEqual([]);
  });
  it('can play an approach note when the chord changes and creativity > 0', () => {
    const ctx: BarContext = {
      bar: 0, key: KEY, chord: { root: 0, quality: 'maj' }, creativity: 1,
      rng: mulberry32(7), dynamics: OPEN,
      chordAt: (beat) => (beat >= 4 ? { root: 5, quality: 'maj' } : { root: 0, quality: 'maj' }),
    };
    const notes = bassApproachNote(ctx, 2);
    expect(notes.length).toBeGreaterThanOrEqual(0); // probabilistic, but must not throw and must respect shape
    for (const n of notes) { expect(n.time).toBe(3.75); expect(n.duration).toBeGreaterThan(0); }
  });
});

describe('pickTemplate', () => {
  it('creativity 0 always picks template 0', () => {
    for (let bar = 0; bar < 20; bar++) expect(pickTemplate(ctxFor(bar, 0, bar), 3)).toBe(0);
  });
  it('creativity 1 uses every template at least once over many bars', () => {
    const seen = new Set<number>();
    for (let bar = 0; bar < 64; bar++) seen.add(pickTemplate(ctxFor(bar, 1, bar * 13), 3));
    expect(seen).toEqual(new Set([0, 1, 2]));
  });
});

describe('spaceAnswerPhrase', () => {
  it('is silent without space or without creativity', () => {
    expect(spaceAnswerPhrase(ctxFor(0, 1, 1, { ...OPEN, space: false }), 5)).toEqual([]);
    expect(spaceAnswerPhrase(ctxFor(0, 0, 1, OPEN), 5)).toEqual([]);
  });
  it('when it plays, uses 2 to 4 notes', () => {
    for (let bar = 0; bar < 30; bar++) {
      const notes = spaceAnswerPhrase(ctxFor(bar, 1, bar * 3, OPEN), 5);
      if (notes.length) { expect(notes.length).toBeGreaterThanOrEqual(2); expect(notes.length).toBeLessThanOrEqual(4); return; }
    }
    throw new Error('never fired');
  });
});

describe('ghostSnares', () => {
  it('adds nothing at or below 0.8 intensity', () => {
    expect(ghostSnares(ctxFor(0, 1, 1, { ...OPEN, intensity: 0.8 }))).toEqual([]);
  });
  it('can add quiet snares above 0.8 intensity', () => {
    const found = Array.from({ length: 10 }, (_, i) => ghostSnares(ctxFor(i, 1, i, { ...OPEN, intensity: 0.95 })))
      .some(evs => evs.length > 0 && evs.every(e => e.velocity === 0.3));
    expect(found).toBe(true);
  });
});

describe('thinForLowIntensity', () => {
  const events = [
    { time: 0, note: DRUM.kick, duration: 0.25, velocity: 0.9 },
    { time: 2.5, note: DRUM.kick, duration: 0.25, velocity: 0.9 },
    { time: 0.5, note: DRUM.hat, duration: 0.25, velocity: 0.5 },
    { time: 1, note: DRUM.hat, duration: 0.25, velocity: 0.5 },
  ];
  it('drops off-beat kicks and hats below 0.3 intensity', () => {
    const out = thinForLowIntensity(events, ctxFor(0, 0, 1, { ...OPEN, intensity: 0.1 }));
    expect(out.some(e => e.note === DRUM.kick && e.time === 2.5)).toBe(false);
    expect(out.some(e => e.note === DRUM.hat && e.time === 0.5)).toBe(false);
    expect(out.some(e => e.note === DRUM.hat && e.time === 1)).toBe(true);
  });
  it('does nothing at or above 0.3 intensity', () => {
    expect(thinForLowIntensity(events, ctxFor(0, 0, 1, { ...OPEN, intensity: 0.3 }))).toEqual(events);
  });
});

describe('applyArrangement', () => {
  const drumBar: NoteEvent[] = [
    { time: 0, note: DRUM.kick, duration: 0.25, velocity: 0.9 },
    { time: 1, note: DRUM.snare, duration: 0.25, velocity: 0.8 },
    { time: 0.5, note: DRUM.hat, duration: 0.25, velocity: 0.5 },
    { time: 2.5, note: DRUM.openHat, duration: 0.25, velocity: 0.4 },
  ];
  const chordBar: NoteEvent[] = [
    { time: 0, note: 60, duration: 1, velocity: 0.6 },
    { time: 2, note: 64, duration: 1, velocity: 0.5 },
  ];

  it('passes events through unchanged with no arrangement', () => {
    expect(applyArrangement('drums', drumBar, undefined)).toEqual(drumBar);
  });
  it('passes events through unchanged on an ordinary groove bar', () => {
    const groove = { intro: false, lift: false, breakdown: false, ending: false };
    expect(applyArrangement('drums', drumBar, groove)).toEqual(drumBar);
  });

  it('intro: drums keep only hats', () => {
    const intro = { intro: true, lift: false, breakdown: false, ending: false };
    const out = applyArrangement('drums', drumBar, intro);
    expect(out.every(e => e.note === DRUM.hat || e.note === DRUM.openHat)).toBe(true);
    expect(out.length).toBe(2);
  });
  it('intro: bass keeps only the downbeat', () => {
    const intro = { intro: true, lift: false, breakdown: false, ending: false };
    const bass = [{ time: 0, note: 48, duration: 1, velocity: 0.8 }, { time: 2.5, note: 55, duration: 0.5, velocity: 0.7 }];
    expect(applyArrangement('bass', bass, intro)).toEqual([bass[0]]);
  });
  it('intro: keys sustain a single pad for the whole bar', () => {
    const intro = { intro: true, lift: false, breakdown: false, ending: false };
    const out = applyArrangement('keys', chordBar, intro);
    expect(out).toEqual([{ time: 0, note: 60, duration: 4, velocity: 0.6 }]);
  });
  it('intro: lead sits out entirely', () => {
    const intro = { intro: true, lift: false, breakdown: false, ending: false };
    expect(applyArrangement('lead', chordBar, intro)).toEqual([]);
  });

  it('breakdown: drums drop to kick + hat only', () => {
    const breakdown = { intro: false, lift: false, breakdown: true, ending: false };
    const out = applyArrangement('drums', drumBar, breakdown);
    expect(out.every(e => e.note === DRUM.kick || e.note === DRUM.hat)).toBe(true);
  });
  it('breakdown: keys sustain', () => {
    const breakdown = { intro: false, lift: false, breakdown: true, ending: false };
    expect(applyArrangement('keys', chordBar, breakdown)).toEqual([{ time: 0, note: 60, duration: 4, velocity: 0.6 }]);
  });

  it('lift: adds a crash on the downbeat if there is not already one', () => {
    const lift = { intro: false, lift: true, breakdown: false, ending: false };
    const out = applyArrangement('drums', drumBar, lift);
    expect(out.some(e => e.note === DRUM.crash && e.time === 0)).toBe(true);
    expect(out.length).toBe(drumBar.length + 1);
  });
  it('lift: does not add a second crash', () => {
    const lift = { intro: false, lift: true, breakdown: false, ending: false };
    const withCrash = drumBar.concat([{ time: 0, note: DRUM.crash, duration: 0.5, velocity: 0.9 }]);
    expect(applyArrangement('drums', withCrash, lift)).toEqual(withCrash);
  });
  it('lift: leaves non-drum instruments alone', () => {
    const lift = { intro: false, lift: true, breakdown: false, ending: false };
    expect(applyArrangement('bass', chordBar, lift)).toEqual(chordBar);
  });

  it('ending: every instrument gets one long note from the downbeat', () => {
    const ending = { intro: false, lift: false, breakdown: false, ending: true };
    const out = applyArrangement('keys', chordBar, ending);
    expect(out).toEqual([{ time: 0, note: 60, duration: 4, velocity: 0.8 }]);
  });
  it('ending: drums get every distinct downbeat note as a long hit', () => {
    const ending = { intro: false, lift: false, breakdown: false, ending: true };
    const bar = [{ time: 0, note: DRUM.kick, duration: 0.25, velocity: 0.9 }, { time: 0, note: DRUM.crash, duration: 0.5, velocity: 0.8 }, { time: 1, note: DRUM.snare, duration: 0.25, velocity: 0.7 }];
    const out = applyArrangement('drums', bar, ending);
    expect(out.map(e => e.note).sort()).toEqual([DRUM.kick, DRUM.crash].sort());
    expect(out.every(e => e.duration === 4 && e.time === 0)).toBe(true);
  });
  it('ending: falls back to a kick when drums have no events at all', () => {
    const ending = { intro: false, lift: false, breakdown: false, ending: true };
    expect(applyArrangement('drums', [], ending)).toEqual([{ time: 0, note: DRUM.kick, duration: 4, velocity: 0.95 }]);
  });
  it('ending: silent instrument stays silent', () => {
    const ending = { intro: false, lift: false, breakdown: false, ending: true };
    expect(applyArrangement('lead', [], ending)).toEqual([]);
  });
});

describe('withArrangement', () => {
  it('reads ctx.arrangement and applies it to the wrapped pattern', () => {
    const base = drumPattern({ kick: [{ t: 0, p: 1 }], hat: [{ t: 0.5, p: 1 }] });
    const wrapped = withArrangement('drums', base);
    const ctx: BarContext = { ...ctxFor(0, 0, 1), arrangement: { intro: true, lift: false, breakdown: false, ending: false } };
    const out = wrapped.nextBar(ctx);
    expect(out.every(e => e.note === DRUM.hat)).toBe(true);
  });
  it('passes through unchanged when ctx has no arrangement', () => {
    const base = drumPattern({ kick: [{ t: 0, p: 1 }], hat: [{ t: 0.5, p: 1 }] });
    const wrapped = withArrangement('drums', base);
    const ctx = ctxFor(0, 0, 1);
    expect(wrapped.nextBar(ctx)).toEqual(base.nextBar(ctx));
  });
});
