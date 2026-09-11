import { drumPattern, bassPattern, chordPattern, leadPattern } from './toolkit';
import { DRUM } from '../types';
import type { Instrument, Pattern } from '../types';
export const rock: Record<Instrument, Pattern> = {
  drums: drumPattern({
    kick: [{ t: 0, p: 1 }, { t: 2, p: 1 }, { t: 2.5, p: 0.5 }],
    snare: [{ t: 1, p: 1 }, { t: 3, p: 1 }],
    hat: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map(t => ({ t, p: 1, vel: 0.7 })),
    crash: [{ t: 0, p: 0, vel: 0.8 }],
  }, () => [3, 3.25, 3.5, 3.75].map(time => ({ time, note: DRUM.snare, duration: 0.25, velocity: 0.8 }))),
  bass: bassPattern([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map(t => ({ t, degree: t < 3.5 ? 0 : 6, p: t === 3.5 ? 0.4 : 1, dur: 0.5 })), 2),
  keys: chordPattern([[0, 2, 4], [5, 7, 9], [3, 5, 7], [4, 6, 8]], [{ t: 0, p: 1, dur: 4, vel: 0.6 }, { t: 2, p: 0.4, dur: 2, vel: 0.5 }], 3),
  lead: leadPattern([
    [{ t: 0, idx: 2, p: 1, dur: 1 }, { t: 1, idx: 3, p: 1, dur: 1 }, { t: 2, idx: 4, p: 1, dur: 2 }],
    [{ t: 0, idx: 5, p: 1, dur: 1.5 }, { t: 1.5, idx: 4, p: 1, dur: 0.5 }, { t: 2, idx: 2, p: 0.8, dur: 2 }],
  ], 4),
};
