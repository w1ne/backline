import { describe, it, expect } from 'vitest';
import { Bandleader } from './bandleader';
import type { ClockLike } from './clockTypes';
import { PATTERNS } from '../patterns';
import type { Arrangement, BarContext, Dynamics, Genre, Instrument, NoteEvent, Pattern } from '../types';
import { GENRES, IDLE_DYNAMICS, INSTRUMENTS } from '../types';

class FakeClock implements ClockLike {
  cb?: (bar: number, t: number) => void;
  bpm = 0;
  stopped = false;
  start(bpm: number) {
    this.bpm = bpm;
    this.stopped = false;
  }
  stop() {
    this.stopped = true;
  }
  onBar(cb: (bar: number, t: number) => void) {
    this.cb = cb;
  }
  setBpm(bpm: number) {
    this.bpm = bpm;
  }
  tick(bar: number) {
    this.cb!(bar, bar * 2);
  }
}
const mk = () => {
  const clock = new FakeClock();
  const calls: { i: Instrument; n: number; t: number; ev: NoteEvent[] }[] = [];
  const players = {
    schedule: (i: Instrument, ev: NoteEvent[], t: number) => calls.push({ i, n: ev.length, t, ev }),
  };
  const b = new Bandleader(clock, players, PATTERNS, 7);
  b.start(120, 0);
  return { clock, calls, b };
};
/** Pitch classes of bar 2's (first post-intro) bass line, at creativity 0 so the shape is
 *  deterministic. Bars 0-1 are consumed first so the form's intro (which reduces bass to a
 *  single root hit) is out of the way. */
function barNotes(setup: (b: Bandleader) => void): number[] {
  const { clock, calls, b } = mk();
  b.set({ key: { root: 0, mode: 'major' }, creativity: 0 });
  b.setEnabled('bass', true);
  clock.tick(0);
  clock.tick(1);
  setup(b);
  clock.tick(2);
  return calls[2].ev.map(e => e.note % 12);
}
describe('Bandleader', () => {
  it('schedules only enabled instruments', () => {
    const { clock, calls, b } = mk();
    b.setEnabled('drums', true);
    clock.tick(0);
    expect(calls.map((c) => c.i)).toEqual(['drums']);
    b.setEnabled('bass', true);
    clock.tick(1);
    expect(calls.slice(1).map((c) => c.i).sort()).toEqual(['bass', 'drums']);
  });
  it('passes the bar start time through', () => {
    const { clock, calls, b } = mk();
    b.setEnabled('keys', true);
    clock.tick(3);
    expect(calls[0].t).toBe(6);
  });
  it('genre change applies on next bar', () => {
    const { clock, calls, b } = mk();
    b.setEnabled('drums', true);
    clock.tick(0);
    b.set({ genre: 'rock' });
    clock.tick(1);
    expect(calls.length).toBe(2); // no throw, both bars scheduled
  });
  it('skips scheduling a bar whose start time is already in the past', () => {
    const clock = new FakeClock();
    const calls: { i: Instrument; n: number; t: number }[] = [];
    const players = {
      schedule: (i: Instrument, ev: NoteEvent[], t: number) => calls.push({ i, n: ev.length, t }),
    };
    const b = new Bandleader(clock, players, PATTERNS, 7, () => 100);
    b.start(120, 0);
    b.setEnabled('drums', true);
    clock.tick(0); // t = 0, already "past" relative to now() = 100
    expect(calls.length).toBe(0);
    clock.tick(1); // t = 2, still past
    expect(calls.length).toBe(0);
  });

  it('onBarCb receives the bar index on each tick', () => {
    const { clock, b } = mk();
    const bars: number[] = [];
    b.onBarCb = (bar) => bars.push(bar);
    clock.tick(0);
    clock.tick(1);
    clock.tick(5);
    expect(bars).toEqual([0, 1, 5]);
  });
  it('bass follows the chord from the bar after it was set', () => {
    const { clock, calls, b } = mk();
    b.set({ key: { root: 0, mode: 'major' } });
    b.setEnabled('bass', true);
    b.set({ chord: { root: 0, quality: 'maj' }, chordBeat: 0 });
    clock.tick(0);
    b.set({ chord: { root: 5, quality: 'maj' }, chordBeat: 4 });
    clock.tick(1);
    const roots = calls.map(c => c.ev[0].note % 12);
    expect(roots).toEqual([0, 5]); // C then F
  });
  it('a chord landing at the half bar only moves the hits after it', () => {
    // Bar 2 runs beats 8-11; a G arriving on beat 10 is heard by the back half only.
    const held = barNotes(b => {
      b.set({ chord: { root: 0, quality: 'maj' }, chordBeat: 8 });
    });
    const changed = barNotes(b => {
      b.set({ chord: { root: 0, quality: 'maj' }, chordBeat: 8 });
      b.set({ chord: { root: 7, quality: 'maj' }, chordBeat: 10 });
    });
    expect(held).toEqual([0, 0, 7]); // all voiced against C
    expect(changed).toEqual([0, 7, 2]); // beat 8 still C; beat 10+ is G, its fifth
  });
  it('colors a stored chord for the active genre (jazz gives I a maj7)', () => {
    const { b } = mk();
    b.set({ genre: 'jazz', key: { root: 0, mode: 'major' } });
    b.set({ chord: { root: 0, quality: 'maj' }, chordBeat: 0 });
    expect(b.state.chord).toEqual({ root: 0, quality: 'maj7' });
    expect(b.chordAtBeat(0)).toEqual({ root: 0, quality: 'maj7' });
  });
  it('rock leaves the stored chord as a plain triad', () => {
    const { b } = mk();
    b.set({ genre: 'rock', key: { root: 0, mode: 'major' } });
    b.set({ chord: { root: 2, quality: 'min' }, chordBeat: 0 });
    expect(b.state.chord).toEqual({ root: 2, quality: 'min' });
  });
  it('falls back to the key tonic triad when no chord was ever set', () => {
    const { clock, calls, b } = mk();
    b.set({ key: { root: 9, mode: 'minor' } });
    b.setEnabled('bass', true);
    clock.tick(0);
    expect(calls[0].ev[0].note % 12).toBe(9);
  });
});

describe('Bandleader song form', () => {
  /** A Bandleader wired to a spy pattern bank that just records the arrangement it was
   *  handed each bar, instead of real genre patterns. */
  const mkSpy = (dynamics: Dynamics = IDLE_DYNAMICS) => {
    const clock = new FakeClock();
    const seen: (Arrangement | undefined)[] = [];
    const spy: Pattern = { nextBar(ctx: BarContext) { seen.push(ctx.arrangement); return [{ time: 0, note: 60, duration: 1, velocity: 0.8 }]; } };
    const bank = Object.fromEntries(INSTRUMENTS.map(i => [i, spy])) as Record<Instrument, Pattern>;
    const patterns = Object.fromEntries(GENRES.map(g => [g, bank])) as Record<Genre, Record<Instrument, Pattern>>;
    const players = { schedule: () => {} };
    const b = new Bandleader(clock, players, patterns, 1);
    b.set({ dynamics });
    b.setEnabled('drums', true);
    b.start(120, 0);
    return { clock, seen, b };
  };

  it('marks the first two bars as intro, then groove', () => {
    const { clock, seen } = mkSpy();
    clock.tick(0);
    clock.tick(1);
    clock.tick(2);
    expect(seen[0]).toEqual({ intro: true, lift: false, breakdown: false, ending: false });
    expect(seen[1]).toEqual({ intro: true, lift: false, breakdown: false, ending: false });
    expect(seen[2]).toEqual({ intro: false, lift: false, breakdown: false, ending: false });
  });

  it('lifts after 4 bars of high intensity, past intro', () => {
    const { clock, seen, b } = mkSpy();
    clock.tick(0); clock.tick(1); // intro
    b.set({ dynamics: { ...IDLE_DYNAMICS, intensity: 0.9 } });
    clock.tick(2); clock.tick(3); clock.tick(4); clock.tick(5);
    expect(seen[5]).toEqual({ intro: false, lift: true, breakdown: false, ending: false });
  });

  it('breaks down after 4 bars of low intensity, past intro', () => {
    const { clock, seen, b } = mkSpy();
    clock.tick(0); clock.tick(1);
    b.set({ dynamics: { ...IDLE_DYNAMICS, intensity: 0.05 } });
    clock.tick(2); clock.tick(3); clock.tick(4); clock.tick(5);
    expect(seen[5]).toEqual({ intro: false, lift: false, breakdown: true, ending: false });
  });

  it('plays one ending bar after two bars of silence, then stops the clock itself', () => {
    const { clock, seen, b } = mkSpy();
    clock.tick(0); clock.tick(1); // intro
    b.set({ dynamics: { ...IDLE_DYNAMICS, silenceBeats: 8 } });
    clock.tick(2);
    expect(seen[2]).toEqual({ intro: false, lift: false, breakdown: false, ending: true });
    expect(clock.stopped).toBe(true);
  });

  it('does not end while still in the intro, even with lots of silence', () => {
    const { clock, seen, b } = mkSpy();
    b.set({ dynamics: { ...IDLE_DYNAMICS, silenceBeats: 20 } });
    clock.tick(0);
    expect(seen[0]).toEqual({ intro: true, lift: false, breakdown: false, ending: false });
    expect(clock.stopped).toBe(false);
  });

  it('restarting the band resets the form back to intro', () => {
    const { clock, seen, b } = mkSpy();
    clock.tick(0); clock.tick(1);
    b.set({ dynamics: { ...IDLE_DYNAMICS, silenceBeats: 8 } });
    clock.tick(2); // ends and stops
    b.start(120, 0); // restart, as the app does on the singer's next onset
    clock.tick(0);
    expect(seen[3]).toEqual({ intro: true, lift: false, breakdown: false, ending: false });
  });
});
