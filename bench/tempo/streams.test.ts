import { describe, expect, it } from 'vitest';
import { notesFromPitchFrames } from './streams';

describe('notesFromPitchFrames', () => {
  it('segments runs of the same stable midi into notes with start and end', () => {
    const f = [
      { t: 0.0, midi: null }, { t: 0.05, midi: 60 }, { t: 0.1, midi: 60 }, { t: 0.15, midi: 62 },
      { t: 0.2, midi: 62 }, { t: 0.25, midi: null }, { t: 0.3, midi: 64 },
    ];
    expect(notesFromPitchFrames(f)).toEqual([
      { start: 0.05, end: 0.15, midi: 60 },
      { start: 0.15, end: 0.25, midi: 62 },
      { start: 0.3, end: 0.35, midi: 64 },
    ]);
  });
});
