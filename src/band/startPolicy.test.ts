import { describe, it, expect } from 'vitest';
import { initialTempo } from './startPolicy';

describe('voice-only startup', () => {
  it('starts a stable voice without requiring a manually entered tempo', () => {
    expect(initialTempo({ micOnly: true, stablePitch: true, bpm: null, voiceBpm: null })).toBe(100);
  });
  it('uses the available session tempo before the voice estimate', () => {
    expect(initialTempo({ micOnly: true, stablePitch: true, bpm: 120, voiceBpm: 96 })).toBe(120);
  });
  it('uses a voice estimate when available', () => {
    expect(initialTempo({ micOnly: true, stablePitch: true, bpm: null, voiceBpm: 96 })).toBe(96);
  });
  it('does not start on silence or unstable pitch', () => {
    expect(initialTempo({ micOnly: true, stablePitch: false, bpm: null, voiceBpm: 96 })).toBeNull();
  });
  it('keeps MIDI tempo detection as the startup condition', () => {
    expect(initialTempo({ micOnly: false, stablePitch: true, bpm: null, voiceBpm: 96 })).toBeNull();
    expect(initialTempo({ micOnly: false, stablePitch: false, bpm: 110, voiceBpm: null })).toBe(110);
  });
  it('rejects invalid tempo estimates', () => {
    expect(initialTempo({ micOnly: true, stablePitch: true, bpm: NaN, voiceBpm: -1 })).toBe(100);
  });
});
