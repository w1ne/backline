import { drumPattern, bassPattern, chordPattern, leadPattern } from './toolkit';
import { chooseTemplate, withDrumPhrasing, withBassApproach, withSpaceAnswer } from './variation';
import { DRUM } from '../types';
import type { Instrument, Pattern } from '../types';

const drumFill = () => [3, 3.25, 3.5, 3.75].map(time => ({ time, note: DRUM.snare, duration: 0.25, velocity: 0.8 }));

const drums0 = drumPattern({
  kick: [{ t: 0, p: 1 }, { t: 2, p: 1 }, { t: 2.5, p: 0.5 }],
  snare: [{ t: 1, p: 1 }, { t: 3, p: 1 }],
  hat: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map(t => ({ t, p: 1, vel: 0.7 })),
  crash: [{ t: 0, p: 0, vel: 0.8 }],
}, drumFill);
// Template 1: driving 16th-note hats.
const drums1 = drumPattern({
  kick: [{ t: 0, p: 1 }, { t: 2, p: 1 }],
  snare: [{ t: 1, p: 1 }, { t: 3, p: 1 }],
  hat: Array.from({ length: 16 }, (_, i) => ({ t: i / 4, p: 1, vel: i % 4 ? 0.4 : 0.7 })),
}, drumFill);
// Template 2: tom pickup into beat 3, sparser hats.
const drums2 = drumPattern({
  kick: [{ t: 0, p: 1 }, { t: 1.75, p: 0.5 }, { t: 2, p: 1 }],
  snare: [{ t: 1, p: 1 }, { t: 1.5, p: 0.4 }, { t: 3, p: 1 }],
  hat: [0, 1, 2, 3].map(t => ({ t, p: 1, vel: 0.65 })),
}, drumFill);

const bass0 = bassPattern([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map(t => ({ t, degree: t < 3.5 ? 0 : 6, p: t === 3.5 ? 0.4 : 1, dur: 0.5 })), 2);
// Template 1: half-note pedal.
const bass1 = bassPattern([{ t: 0, degree: 0, p: 1, dur: 2 }, { t: 2, degree: 0, p: 1, dur: 2 }], 2);
// Template 2: driving quarter-note root-fifth.
const bass2 = bassPattern([{ t: 0, degree: 0, p: 1, dur: 1 }, { t: 1, degree: 4, p: 1, dur: 1 }, { t: 2, degree: 0, p: 1, dur: 1 }, { t: 3, degree: 4, p: 1, dur: 1 }], 2);

export const rock: Record<Instrument, Pattern> = {
  drums: withDrumPhrasing(chooseTemplate([drums0, drums1, drums2])),
  bass: withBassApproach(chooseTemplate([bass0, bass1, bass2]), 2),
  keys: withSpaceAnswer(chordPattern([[0, 2, 4], [5, 7, 9], [3, 5, 7], [4, 6, 8]], [{ t: 0, p: 1, dur: 4, vel: 0.6 }, { t: 2, p: 0.4, dur: 2, vel: 0.5 }], 3), 3),
  lead: leadPattern([
    [{ t: 0, idx: 2, p: 1, dur: 1 }, { t: 1, idx: 3, p: 1, dur: 1 }, { t: 2, idx: 4, p: 1, dur: 2 }],
    [{ t: 0, idx: 5, p: 1, dur: 1.5 }, { t: 1.5, idx: 4, p: 1, dur: 0.5 }, { t: 2, idx: 2, p: 0.8, dur: 2 }],
  ], 4),
};
