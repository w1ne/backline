import { describe, it, expect } from 'vitest';
import { Bandleader } from './bandleader';
import type { ClockLike } from './clockTypes';
import { PATTERNS } from '../patterns';
import type { Instrument, NoteEvent } from '../types';

class FakeClock implements ClockLike {
  cb?: (bar: number, t: number) => void;
  bpm = 0;
  start(bpm: number) {
    this.bpm = bpm;
  }
  stop() {}
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
/** Pitch classes of bar 0's bass line, at creativity 0 so the shape is deterministic. */
function barNotes(setup: (b: Bandleader) => void): number[] {
  const { clock, calls, b } = mk();
  b.set({ key: { root: 0, mode: 'major' }, creativity: 0 });
  b.setEnabled('bass', true);
  setup(b);
  clock.tick(0);
  return calls[0].ev.map(e => e.note % 12);
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
    // Bar 0 runs beats 0-3; a G arriving on beat 2 is heard by the back half only.
    const held = barNotes(b => {
      b.set({ chord: { root: 0, quality: 'maj' }, chordBeat: 0 });
    });
    const changed = barNotes(b => {
      b.set({ chord: { root: 0, quality: 'maj' }, chordBeat: 0 });
      b.set({ chord: { root: 7, quality: 'maj' }, chordBeat: 2 });
    });
    expect(held).toEqual([0, 0, 7, 5]); // all four hits voiced against C
    expect(changed).toEqual([0, 7, 2, 0]); // beats 0-1 still C; beats 2+ are G, its fifth, its fourth
  });
  it('falls back to the key tonic triad when no chord was ever set', () => {
    const { clock, calls, b } = mk();
    b.set({ key: { root: 9, mode: 'minor' } });
    b.setEnabled('bass', true);
    clock.tick(0);
    expect(calls[0].ev[0].note % 12).toBe(9);
  });
});
