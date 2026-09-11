import { drumPattern, bassPattern, chordPattern, leadPattern } from './toolkit';
import { DRUM } from '../types';
import type { Instrument, Pattern } from '../types';
export const funk: Record<Instrument, Pattern> = {
  drums: drumPattern({
    kick: [{ t: 0, p: 1 }, { t: 0.75, p: 0.5 }, { t: 2, p: 1 }, { t: 2.75, p: 0.6 }, { t: 3.5, p: 0.3 }],
    snare: [{ t: 1, p: 1 }, { t: 3, p: 1 }, { t: 1.75, p: 0.3, vel: 0.4 }, { t: 3.75, p: 0.3, vel: 0.4 }],
    hat: Array.from({ length: 16 }, (_, i) => ({ t: i / 4, p: 1, vel: i % 2 ? 0.3 : 0.6 })),
    openHat: [{ t: 2.5, p: 0.4, vel: 0.5 }],
  }, () => [{ time: 3.25, note: DRUM.snare, duration: 0.25, velocity: 0.6 }, { time: 3.5, note: DRUM.kick, duration: 0.25, velocity: 0.9 }, { time: 3.75, note: DRUM.crash, duration: 0.5, velocity: 0.7 }]),
  bass: bassPattern([{ t: 0, degree: 0, p: 1, dur: 0.25 }, { t: 0.5, degree: 0, p: 0.7, dur: 0.25 }, { t: 0.75, degree: 7, p: 1, dur: 0.25 }, { t: 1.5, degree: 4, p: 1, dur: 0.25 }, { t: 2, degree: 0, p: 1, dur: 0.25 }, { t: 2.75, degree: 6, p: 0.5, dur: 0.25 }, { t: 3, degree: 4, p: 1, dur: 0.5 }, { t: 3.5, degree: 3, p: 0.5, dur: 0.25 }], 2),
  keys: chordPattern([[0, 2, 4, 6], [3, 5, 7, 9]], [{ t: 0.5, p: 1, dur: 0.25 }, { t: 1.5, p: 1, dur: 0.25 }, { t: 2.5, p: 1, dur: 0.25 }, { t: 3, p: 0.5, dur: 0.25 }, { t: 3.5, p: 1, dur: 0.25 }], 4),
  lead: leadPattern([
    [{ t: 0, idx: 5, p: 1, dur: 0.25 }, { t: 0.5, idx: 4, p: 1, dur: 0.25 }, { t: 1, idx: 2, p: 1, dur: 0.5 }, { t: 2.5, idx: 3, p: 0.6, dur: 0.25 }],
    [{ t: 1.5, idx: 7, p: 1, dur: 0.25 }, { t: 2, idx: 5, p: 1, dur: 0.75 }, { t: 3.5, idx: 4, p: 0.5, dur: 0.25 }],
  ], 5),
};
