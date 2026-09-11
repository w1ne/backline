import { describe, it, expect } from 'vitest';
import { scaleFor, promptsFor, configFor } from './lyriaMap';
import type { Key } from '../types';

describe('scaleFor', () => {
  it('maps minor key via relative major', () => {
    expect(scaleFor({ root: 9, mode: 'minor' })).toBe('C_MAJOR_A_MINOR');
  });
  it('maps major key directly', () => {
    expect(scaleFor({ root: 7, mode: 'major' })).toBe('G_MAJOR_E_MINOR');
  });
  it('maps minor key with wraparound relative major', () => {
    expect(scaleFor({ root: 4, mode: 'minor' })).toBe('G_MAJOR_E_MINOR');
  });
});

describe('promptsFor', () => {
  it('builds genre + enabled instrument prompts', () => {
    expect(promptsFor('funk', { drums: true, bass: false, keys: true, lead: false })).toEqual([
      { text: 'funk', weight: 1 },
      { text: 'drums', weight: 0.8 },
      { text: 'electric piano chords', weight: 0.7 },
    ]);
  });
});

describe('configFor', () => {
  const key: Key = { root: 0, mode: 'major' };
  const allOn = { drums: true, bass: true, keys: true, lead: true };
  it('clamps bpm and computes temperature/density/mutes', () => {
    const cfg = configFor(300, key, 1, allOn);
    expect(cfg.bpm).toBe(200);
    expect(cfg.temperature).toBeCloseTo(2.2, 5);
    expect(cfg.muteBass).toBe(false);
  });
});
