import { describe, it, expect } from 'vitest';
import { fires, bassPattern, chordPattern, drumPattern, leadPattern, dynVel } from './toolkit';
import { effectiveDynamics } from '../listener/activity';
import type { Dynamics } from '../types';
import { DRUM } from '../types';
import { mulberry32 } from '../rng';
import { scaleOf } from '../music/scales';
const ctx = (creativity: number, seed = 1) => ({ bar: 0, key: { root: 2, mode: 'minor' as const }, creativity, rng: mulberry32(seed) });
const dyn = (p: Partial<Dynamics> = {}): Dynamics => ({ intensity: 0, space: false, fillDue: false, silenceBeats: 0, ...p });
const dctx = (d: Partial<Dynamics>, bar = 0, creativity = 0, seed = 1) => ({ ...ctx(creativity, seed), bar, dynamics: dyn(d) });
describe('fires', () => {
  it('p=1 always fires', () => { expect(fires({ t: 0, p: 1 }, ctx(0))).toBe(true); });
  it('p=0 never fires at creativity 0', () => { for (let i = 0; i < 50; i++) expect(fires({ t: 0, p: 0 }, ctx(0, i))).toBe(false); });
  it('p=0 fires at creativity 1', () => { expect(fires({ t: 0, p: 0 }, ctx(1))).toBe(true); });
});
describe('bassPattern', () => {
  it('stays in key at creativity 0', () => {
    const p = bassPattern([{ t: 0, degree: 0, p: 1 }, { t: 2, degree: 4, p: 1 }], 2);
    const ev = p.nextBar(ctx(0));
    expect(ev.map(e => e.note)).toEqual([38, 45]); // D2, A2
    ev.forEach(e => expect(scaleOf(ctx(0).key)).toContain(e.note % 12));
  });
});

describe('dynVel', () => {
  it('scales 0.6 → 1.0 across the intensity range, and not at all without a listener', () => {
    expect(dynVel(dctx({ intensity: 0 }))).toBeCloseTo(0.6);
    expect(dynVel(dctx({ intensity: 0.5 }))).toBeCloseTo(0.8);
    expect(dynVel(dctx({ intensity: 1 }))).toBeCloseTo(1);
    expect(dynVel(ctx(0))).toBe(1);
  });
});

describe('velocity follows intensity', () => {
  const p = bassPattern([{ t: 0, degree: 0, p: 1 }], 2);
  it('an idle player gets a quiet band', () => {
    expect(p.nextBar(dctx({ intensity: 0 }))[0].velocity).toBeCloseTo(0.85 * 0.6);
    expect(p.nextBar(dctx({ intensity: 1 }))[0].velocity).toBeCloseTo(0.85);
  });
  it('never exceeds 1', () => {
    const loud = drumPattern({ kick: [{ t: 0, p: 1, vel: 1 }] });
    expect(loud.nextBar(dctx({ intensity: 1 }))[0].velocity).toBeLessThanOrEqual(1);
  });
});

describe('leadPattern answers only in the gaps', () => {
  const p = leadPattern([[{ t: 0, idx: 0, p: 1 }]], 5);
  it('is silent while the player is playing', () => { expect(p.nextBar(dctx({ space: false }))).toEqual([]); });
  it('plays when the player leaves space', () => { expect(p.nextBar(dctx({ space: true })).length).toBe(1); });
  it('plays every bar when there is no listener at all', () => { expect(p.nextBar(ctx(0)).length).toBe(1); });
});

describe('chordPattern thins out under a busy player', () => {
  const p = chordPattern([[0]], [{ t: 0, p: 1 }, { t: 2, p: 0.5 }, { t: 3, p: 1 }], 4);
  it('keeps every hit at moderate intensity', () => {
    expect(p.nextBar(dctx({ intensity: 0.5 }, 0, 1)).map(e => e.time)).toEqual([0, 2, 3]);
  });
  it('drops the optional hits above 0.7', () => {
    expect(p.nextBar(dctx({ intensity: 0.8 }, 0, 1)).map(e => e.time)).toEqual([0, 3]);
  });
});

describe('drumPattern fills', () => {
  const fill = () => [{ time: 3.5, note: DRUM.snare, duration: 0.25, velocity: 0.6 }];
  const p = drumPattern({ kick: [{ t: 0, p: 1 }] }, fill);
  it('fills when the tracker says one is due, whatever the bar number', () => {
    expect(p.nextBar(dctx({ fillDue: true }, 1)).some(e => e.time === 3.5)).toBe(true);
  });
  it('does not fill on the last bar of a group while the player is busy', () => {
    expect(p.nextBar(dctx({ fillDue: false, intensity: 0.9 }, 3)).some(e => e.time === 3.5)).toBe(false);
  });
});

describe('optional hits scale with the effective intensity', () => {
  // A single optional step; count how often it fires across many seeds at creativity 0.
  const step = { t: 0, p: 0.4 };
  const rate = (intensity: number): number => {
    let hits = 0;
    for (let i = 0; i < 400; i++) {
      if (fires(step, { ...ctx(0, i), dynamics: dyn({ intensity }) })) hits++;
    }
    return hits / 400;
  };
  it('drops more optional hits when the band is quiet and adds them as it rises', () => {
    const low = rate(0);
    const high = rate(1);
    expect(low).toBeGreaterThan(0.3); // ~0.4 baseline from p alone
    expect(high).toBeGreaterThan(low + 0.15); // intensity boost adds hits
  });
  it('never fires below the creativity-only baseline (no listener behaves as before)', () => {
    // p=0 step, creativity 0, no dynamics: still never fires.
    for (let i = 0; i < 50; i++) expect(fires({ t: 0, p: 0 }, ctx(0, i))).toBe(false);
  });
});

describe('lead plays without space at a high manual intensity', () => {
  const p = leadPattern([[{ t: 0, idx: 0, p: 1 }]], 5);
  it('is silent without space at a moderate manual setting', () => {
    const d = effectiveDynamics(dyn({ space: false }), 0.5);
    expect(p.nextBar({ ...ctx(0), dynamics: d })).toEqual([]);
  });
  it('answers even without space above manual 0.85', () => {
    const d = effectiveDynamics(dyn({ space: false }), 0.9);
    expect(p.nextBar({ ...ctx(0), dynamics: d }).length).toBe(1);
  });
});
