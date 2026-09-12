import { describe, it, expect } from 'vitest';
import { countInClicks } from './countIn';

describe('countInClicks', () => {
  it('produces two bars of 4 clicks at 120bpm', () => {
    const clicks = countInClicks(120, 10);
    expect(clicks).toHaveLength(8);
    expect(clicks.map(c => c.beat)).toEqual([1, 2, 3, 4, 1, 2, 3, 4]);
  });

  it('spaces clicks one beat apart, on the audio clock the band starts on', () => {
    const clicks = countInClicks(120, 10);
    const beatLen = 60 / 120;
    for (let i = 1; i < clicks.length; i++) {
      expect(clicks[i].atSec - clicks[i - 1].atSec).toBeCloseTo(beatLen, 6);
    }
    // last click lands exactly one beat before the band's first bar
    expect(clicks[clicks.length - 1].atSec).toBeCloseTo(10 - beatLen, 6);
  });

  it('scales with a different bpm', () => {
    const clicks = countInClicks(90, 20);
    const beatLen = 60 / 90;
    expect(clicks[0].atSec).toBeCloseTo(20 - 8 * beatLen, 6);
  });
});
