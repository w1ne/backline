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
  const calls: { i: Instrument; n: number; t: number }[] = [];
  const players = {
    schedule: (i: Instrument, ev: NoteEvent[], t: number) => calls.push({ i, n: ev.length, t }),
  };
  const b = new Bandleader(clock, players, PATTERNS, 7);
  b.start(120, 0);
  return { clock, calls, b };
};
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
  it('onBarCb receives the bar index on each tick', () => {
    const { clock, b } = mk();
    const bars: number[] = [];
    b.onBarCb = (bar) => bars.push(bar);
    clock.tick(0);
    clock.tick(1);
    clock.tick(5);
    expect(bars).toEqual([0, 1, 5]);
  });
});
