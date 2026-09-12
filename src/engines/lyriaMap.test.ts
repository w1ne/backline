import { describe, it, expect } from 'vitest';
import { scaleFor, promptsFor, configFor } from './lyriaMap';
import { effectiveIntensity } from '../listener/activity';
import type { Dynamics, Key } from '../types';

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

  it('density follows the effective intensity it is handed', () => {
    const dyn = (intensity: number): Dynamics => ({ intensity, space: false, fillDue: false, silenceBeats: 0 });
    // auto 0.6, manual 0 -> effective 0.24 -> density 0.25 + 0.24*0.5
    const low = effectiveIntensity(0.6, 0);
    expect(configFor(120, key, 0.3, allOn, dyn(low)).density).toBeCloseTo(0.25 + low * 0.5, 5);
    // same auto, manual 1 -> effective 0.96 -> a busier band
    const high = effectiveIntensity(0.6, 1);
    expect(configFor(120, key, 0.3, allOn, dyn(high)).density).toBeCloseTo(0.25 + high * 0.5, 5);
    expect(high).toBeGreaterThan(low);
  });
});
