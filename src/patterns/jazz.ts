import { drumPattern, bassPattern, chordPattern, leadPattern } from './toolkit';
import type { Instrument, Pattern } from '../types';
export const jazz: Record<Instrument, Pattern> = {
  drums: drumPattern({
    hat: [{ t: 1, p: 1, vel: 0.5 }, { t: 3, p: 1, vel: 0.5 }],
    openHat: [{ t: 0, p: 1, vel: 0.5 }, { t: 1.67, p: 1, vel: 0.4 }, { t: 2, p: 1, vel: 0.5 }, { t: 3.67, p: 1, vel: 0.4 }],
    kick: [{ t: 0, p: 0.3, vel: 0.4 }, { t: 2.67, p: 0.3, vel: 0.4 }],
    snare: [{ t: 1.67, p: 0.3, vel: 0.35 }, { t: 3.67, p: 0.4, vel: 0.35 }],
  }),
  bass: bassPattern([{ t: 0, degree: 0, p: 1, dur: 1 }, { t: 1, degree: 2, p: 1, dur: 1 }, { t: 2, degree: 4, p: 1, dur: 1 }, { t: 3, degree: 5, p: 0.7, dur: 1 }, { t: 3, degree: 6, p: 0.3, dur: 1 }], 2),
  keys: chordPattern([[0, 2, 4, 6], [1, 3, 5, 7], [4, 6, 8, 10], [0, 2, 4, 6]], [{ t: 0.67, p: 1, dur: 1, vel: 0.6 }, { t: 2.67, p: 0.6, dur: 1, vel: 0.5 }], 4),
  lead: leadPattern([
    [{ t: 0.67, idx: 4, p: 1, dur: 0.33 }, { t: 1, idx: 5, p: 1, dur: 0.67 }, { t: 2, idx: 3, p: 1, dur: 0.67 }, { t: 2.67, idx: 2, p: 0.7, dur: 1 }],
    [{ t: 0, idx: 7, p: 1, dur: 0.67 }, { t: 1.67, idx: 6, p: 1, dur: 0.33 }, { t: 2, idx: 5, p: 1, dur: 1 }],
  ], 5),
};
