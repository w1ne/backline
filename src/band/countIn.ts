/** One click of the count-in, in beats-since-1 (1..beatsPerBar) so the LCD can show "1 2 3 4". */
export interface CountInClick {
  atSec: number;
  beat: number;
}

/**
 * Two bars (by default) of click times leading up to `bandStartAt`, on the same clock the
 * band's first bar is scheduled on. The last click lands exactly one beat before the band
 * enters.
 */
export function countInClicks(bpm: number, bandStartAt: number, bars = 2, beatsPerBar = 4): CountInClick[] {
  const beatLen = 60 / bpm;
  const totalBeats = bars * beatsPerBar;
  const startAt = bandStartAt - totalBeats * beatLen;
  return Array.from({ length: totalBeats }, (_, i) => ({
    atSec: startAt + i * beatLen,
    beat: (i % beatsPerBar) + 1,
  }));
}
