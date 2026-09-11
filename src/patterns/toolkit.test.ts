import { describe, it, expect } from 'vitest';
import { fires, bassPattern } from './toolkit';
import { mulberry32 } from '../rng';
import { scaleOf } from '../music/scales';
const ctx = (creativity: number, seed = 1) => ({ bar: 0, key: { root: 2, mode: 'minor' as const }, creativity, rng: mulberry32(seed) });
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
