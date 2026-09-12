import { describe, it, expect } from 'vitest';
import { PlanFreshness, chooseChord, chooseSection } from './planOverride';
import type { Chord } from '../types';

const AM: Chord = { root: 9, quality: 'min' };
const F: Chord = { root: 5, quality: 'maj' };

describe('PlanFreshness', () => {
  it('is fresh on the bar a chord arrived, and one bar after', () => {
    const p = new PlanFreshness();
    p.noteChord(3);
    expect(p.chordFresh(3)).toBe(true);
    expect(p.chordFresh(4)).toBe(true);
  });

  it('goes stale two bars after the chord arrived', () => {
    const p = new PlanFreshness();
    p.noteChord(3);
    expect(p.chordFresh(5)).toBe(false);
  });

  it('is never fresh before anything has arrived', () => {
    const p = new PlanFreshness();
    expect(p.chordFresh(0)).toBe(false);
    expect(p.sectionFresh(0)).toBe(false);
  });

  it('tracks section freshness independently of chord freshness', () => {
    const p = new PlanFreshness();
    p.noteChord(3);
    p.noteSection(10);
    expect(p.chordFresh(10)).toBe(false);
    expect(p.sectionFresh(10)).toBe(true);
  });

  it('reset() clears both', () => {
    const p = new PlanFreshness();
    p.noteChord(3);
    p.noteSection(3);
    p.reset();
    expect(p.chordFresh(3)).toBe(false);
    expect(p.sectionFresh(3)).toBe(false);
  });
});

describe('chooseChord', () => {
  it('a fresh plan chord overrides the local one while AMT is live', () => {
    expect(chooseChord('amt', true, F, AM)).toEqual(F);
  });

  it('no plan chord leaves the local path in charge', () => {
    expect(chooseChord('amt', false, null, AM)).toEqual(AM);
  });

  it('a stale plan chord leaves the local path in charge even if one is remembered', () => {
    expect(chooseChord('amt', false, F, AM)).toEqual(AM);
  });

  it('the local path is always in charge off AMT, even with a fresh plan chord remembered', () => {
    expect(chooseChord('patterns', true, F, AM)).toEqual(AM);
  });
});

describe('chooseSection', () => {
  it('a fresh plan section overrides the local one while AMT is live', () => {
    expect(chooseSection('amt', true, 'lift', 'groove')).toBe('lift');
  });

  it('no plan section leaves the local path in charge', () => {
    expect(chooseSection('amt', false, null, 'groove')).toBe('groove');
  });
});
