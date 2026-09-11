import { drumPattern, bassPattern, chordPattern, leadPattern } from './toolkit';
import { DRUM } from '../types';
import type { Instrument, Pattern } from '../types';
export const lofi: Record<Instrument, Pattern> = {
  drums: drumPattern({
    kick: [{ t: 0, p: 1 }, { t: 2.5, p: 1 }, { t: 3.75, p: 0.2 }],
    snare: [{ t: 1, p: 1, vel: 0.7 }, { t: 3, p: 1, vel: 0.7 }, { t: 3.5, p: 0.15, vel: 0.4 }],
    hat: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map(t => ({ t, p: 1, vel: t % 1 ? 0.35 : 0.55 })),
    openHat: [{ t: 3.5, p: 0.25, vel: 0.4 }],
  }, () => [{ time: 3.5, note: DRUM.snare, duration: 0.25, velocity: 0.5 }, { time: 3.75, note: DRUM.snare, duration: 0.25, velocity: 0.6 }]),
  bass: bassPattern([{ t: 0, degree: 0, p: 1, dur: 1.5 }, { t: 2, degree: 0, p: 0.6, dur: 0.5 }, { t: 2.5, degree: 4, p: 1, dur: 1 }, { t: 3.5, degree: 3, p: 0.3, dur: 0.5 }], 2),
  keys: chordPattern([[0, 2, 4, 6], [3, 5, 7, 9], [5, 7, 9, 11], [4, 6, 8, 10]], [{ t: 0, p: 1, dur: 2 }, { t: 2.5, p: 1, dur: 1.5, vel: 0.6 }], 4),
  lead: leadPattern([
    [{ t: 0.5, idx: 4, p: 1 }, { t: 1.5, idx: 3, p: 1 }, { t: 2.5, idx: 2, p: 0.7, dur: 1 }],
    [{ t: 1, idx: 5, p: 1, dur: 1 }, { t: 3, idx: 4, p: 0.8 }],
  ], 5),
};
