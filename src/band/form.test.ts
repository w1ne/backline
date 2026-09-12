import { describe, it, expect } from 'vitest';
import { SongForm } from './form';
import type { Dynamics } from '../types';

const dyn = (intensity: number, silenceBeats = 0): Dynamics => ({ intensity, space: false, fillDue: false, silenceBeats });
const tick = (form: SongForm, bar: number, intensity: number, silenceBeats = 0, playerStopped = false) =>
  form.tick({ bar, dynamics: dyn(intensity, silenceBeats), silenceBeats, playerStopped });

describe('SongForm', () => {
  it('starts in intro for the first two bars', () => {
    const form = new SongForm();
    expect(tick(form, 0, 0.5).section).toBe('intro');
    expect(tick(form, 1, 0.5).section).toBe('intro');
  });

  it('intro bars mark arrangement.intro and nothing else', () => {
    const form = new SongForm();
    const r = tick(form, 0, 0.5);
    expect(r.arrangement).toEqual({ intro: true, lift: false, breakdown: false, ending: false });
  });

  it('moves to groove on bar 2', () => {
    const form = new SongForm();
    tick(form, 0, 0.5);
    tick(form, 1, 0.5);
    const r = tick(form, 2, 0.5);
    expect(r.section).toBe('groove');
    expect(r.arrangement).toEqual({ intro: false, lift: false, breakdown: false, ending: false });
  });

  it('lifts after 4 bars of intensity above 0.7', () => {
    const form = new SongForm();
    tick(form, 0, 0.9); tick(form, 1, 0.9); // still intro, but streak keeps counting
    let last;
    for (let bar = 2; bar < 6; bar++) last = tick(form, bar, 0.9);
    expect(last!.section).toBe('lift');
    expect(last!.arrangement.lift).toBe(true);
  });

  it('does not lift on only 3 bars above threshold', () => {
    const form = new SongForm();
    tick(form, 0, 0.5); tick(form, 1, 0.5);
    let last;
    for (let bar = 2; bar < 5; bar++) last = tick(form, bar, 0.9);
    expect(last!.section).toBe('groove');
  });

  it('breaks down after 4 bars of intensity below 0.3', () => {
    const form = new SongForm();
    tick(form, 0, 0.1); tick(form, 1, 0.1);
    let last;
    for (let bar = 2; bar < 6; bar++) last = tick(form, bar, 0.1);
    expect(last!.section).toBe('breakdown');
    expect(last!.arrangement.breakdown).toBe(true);
  });

  it('returns to groove once intensity is neither high nor low', () => {
    const form = new SongForm();
    tick(form, 0, 0.9); tick(form, 1, 0.9);
    for (let bar = 2; bar < 6; bar++) tick(form, bar, 0.9);
    const r = tick(form, 6, 0.5);
    expect(r.section).toBe('groove');
  });

  it('can go from lift straight into breakdown territory (the * in the sequence)', () => {
    const form = new SongForm();
    tick(form, 0, 0.9); tick(form, 1, 0.9);
    for (let bar = 2; bar < 6; bar++) tick(form, bar, 0.9); // -> lift
    let last;
    for (let bar = 6; bar < 10; bar++) last = tick(form, bar, 0.1); // -> breakdown
    expect(last!.section).toBe('breakdown');
  });

  it('ends after four full bars (16 beats) of silence, past intro', () => {
    const form = new SongForm();
    tick(form, 0, 0.5); tick(form, 1, 0.5);
    const r = tick(form, 2, 0, 16);
    expect(r.section).toBe('ending');
    expect(r.arrangement).toEqual({ intro: false, lift: false, breakdown: false, ending: true });
    expect(r.shouldStop).toBe(true);
  });

  it('does not end on less than 8 silent beats', () => {
    const form = new SongForm();
    tick(form, 0, 0.5); tick(form, 1, 0.5);
    const r = tick(form, 2, 0, 7.9);
    expect(r.section).not.toBe('ending');
    expect(r.shouldStop).toBe(false);
  });

  it('never ends during intro even if silent', () => {
    const form = new SongForm();
    const r = tick(form, 0, 0, 20);
    expect(r.section).toBe('intro');
    expect(r.shouldStop).toBe(false);
  });

  it('ends immediately when playerStopped is set, regardless of silenceBeats', () => {
    const form = new SongForm();
    tick(form, 0, 0.5); tick(form, 1, 0.5);
    const r = form.tick({ bar: 2, dynamics: dyn(0.5), silenceBeats: 0, playerStopped: true });
    expect(r.section).toBe('ending');
    expect(r.shouldStop).toBe(true);
  });

  it('goes idle (ended) the tick after the ending bar, and stays idle', () => {
    const form = new SongForm();
    tick(form, 0, 0.5); tick(form, 1, 0.5);
    tick(form, 2, 0, 16);
    const r1 = tick(form, 3, 0.5, 0);
    expect(r1.section).toBe('ended');
    expect(r1.shouldStop).toBe(false);
    const r2 = tick(form, 4, 0.9, 0);
    expect(r2.section).toBe('ended');
  });

  it('reset() returns the form to intro', () => {
    const form = new SongForm();
    tick(form, 0, 0.5); tick(form, 1, 0.5);
    tick(form, 2, 0, 16);
    tick(form, 3, 0.5);
    form.reset();
    const r = tick(form, 0, 0.5);
    expect(r.section).toBe('intro');
  });
});
