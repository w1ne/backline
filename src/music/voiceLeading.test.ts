import { describe, it, expect } from 'vitest';
import type { Chord } from '../types';
import { voiceLead } from './voiceLeading';

const RANGE = { low: 55, high: 76 };

const chord = (root: number, quality: Chord['quality']): Chord => ({ root, quality });

describe('voiceLead', () => {
  it('keeps all notes within [low, high]', () => {
    const chords: Chord[] = [chord(9, 'min'), chord(5, 'maj'), chord(0, 'maj'), chord(7, 'dom7'), chord(2, 'min7')];
    let prev: number[] | null = null;
    for (const c of chords) {
      const v = voiceLead(prev, c, RANGE);
      for (const n of v) {
        expect(n).toBeGreaterThanOrEqual(RANGE.low);
        expect(n).toBeLessThanOrEqual(RANGE.high);
      }
      prev = v;
    }
  });

  it('produces distinct pitches with no duplicates', () => {
    const v = voiceLead(null, chord(0, 'maj7'), RANGE);
    expect(new Set(v).size).toBe(v.length);
  });

  it('gives 3 voices for a triad and 4 for a seventh chord', () => {
    expect(voiceLead(null, chord(0, 'maj'), RANGE)).toHaveLength(3);
    expect(voiceLead(null, chord(0, 'maj7'), RANGE)).toHaveLength(4);
  });

  it('Cmaj7 produces four distinct MIDI notes matching chord tones', () => {
    const v = voiceLead(null, chord(0, 'maj7'), RANGE);
    expect(new Set(v).size).toBe(4);
    const pcs = new Set(v.map(n => ((n % 12) + 12) % 12));
    expect(pcs).toEqual(new Set([0, 4, 7, 11]));
  });

  it('caps a 9th chord (5 tones) at 4 voices, all of them real chord tones', () => {
    const v = voiceLead(null, chord(0, 'dom9'), RANGE);
    expect(v).toHaveLength(4);
    expect(new Set(v).size).toBe(4);
    const pcs = v.map(n => ((n % 12) + 12) % 12);
    for (const pc of pcs) expect([0, 4, 7, 10, 2]).toContain(pc); // root, 3rd, 5th, b7, 9th
  });

  it('respects an explicit voices override', () => {
    const v = voiceLead(null, chord(0, 'maj'), { ...RANGE, voices: 4 });
    expect(v).toHaveLength(4);
  });

  it('when prev is null picks a voicing near the middle of the range', () => {
    const v = voiceLead(null, chord(0, 'maj'), RANGE);
    const mid = (RANGE.low + RANGE.high) / 2;
    const avg = v.reduce((a, b) => a + b, 0) / v.length;
    expect(Math.abs(avg - mid)).toBeLessThan(12);
  });

  it('smooth voice leading through Am F C G Am: low average movement, no octave-jumping every change', () => {
    const progression: Chord[] = [chord(9, 'min'), chord(5, 'maj'), chord(0, 'maj'), chord(7, 'maj'), chord(9, 'min')];
    let prev: number[] | null = null;
    const movements: number[] = [];
    const voicings: number[][] = [];
    for (const c of progression) {
      const v = voiceLead(prev, c, RANGE);
      if (prev) {
        // pair by sorted order for a stable per-voice movement measure
        const a = [...prev].sort((x, y) => x - y);
        const b = [...v].sort((x, y) => x - y);
        const total = a.reduce((sum, n, i) => sum + Math.abs(n - b[i]), 0);
        movements.push(total / a.length);
      }
      voicings.push(v);
      prev = v;
    }
    const avgMovement = movements.reduce((a, b) => a + b, 0) / movements.length;
    expect(avgMovement).toBeLessThanOrEqual(2.5);
    // consecutive different chords should not produce identical voicings
    for (let i = 1; i < voicings.length; i++) {
      const same = JSON.stringify([...voicings[i]].sort()) === JSON.stringify([...voicings[i - 1]].sort());
      expect(same).toBe(false);
    }
  });

  it('no single voice moves more than 7 semitones when a smaller-movement option exists', () => {
    // C major to G major triad, adjacent chords sharing a common tone (G, B shared-ish) — should not leap
    let prev = voiceLead(null, chord(0, 'maj'), RANGE);
    const v = voiceLead(prev, chord(7, 'maj'), RANGE);
    const a = [...prev].sort((x, y) => x - y);
    const b = [...v].sort((x, y) => x - y);
    const maxLeap = Math.max(...a.map((n, i) => Math.abs(n - b[i])));
    expect(maxLeap).toBeLessThanOrEqual(7);
  });
});
