import { describe, it, expect } from 'vitest';
import { waitsForGivenTempo, tempoHint } from './startPolicy';
import { Store } from '../ui/state';

describe('how a session gets its first tempo', () => {
  it('the count-in is on by default', () => {
    expect(new Store().state.countIn).toBe(true);
  });

  it('a mic-only session with the count-in on waits for a tapped or typed tempo', () => {
    expect(waitsForGivenTempo({ micOnly: true, countIn: true, hasBpmOverride: false })).toBe(true);
  });

  it('a typed or tapped bpm is the given tempo', () => {
    expect(waitsForGivenTempo({ micOnly: true, countIn: true, hasBpmOverride: true })).toBe(false);
  });

  it('turning the count-in off restores the onset-driven start', () => {
    expect(waitsForGivenTempo({ micOnly: true, countIn: false, hasBpmOverride: false })).toBe(false);
  });

  it('MIDI sessions are unchanged: the detected tempo starts the band', () => {
    expect(waitsForGivenTempo({ micOnly: false, countIn: true, hasBpmOverride: false })).toBe(false);
    expect(waitsForGivenTempo({ micOnly: false, countIn: false, hasBpmOverride: false })).toBe(false);
  });

  it('shows the syllable rate as a hint, not a tempo', () => {
    expect(tempoHint(140.4)).toBe('~140 spoken');
    expect(tempoHint(null)).toBe('');
  });
});
