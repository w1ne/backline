import { drumPattern, bassPattern, chordPattern, leadPattern } from './toolkit';
import { chooseTemplate, withDrumPhrasing, withBassApproach, withSpaceAnswer, withArrangement } from './variation';
import { DRUM } from '../types';
import type { Instrument, Pattern } from '../types';

const drumFill = () => [{ time: 3.5, note: DRUM.snare, duration: 0.25, velocity: 0.5 }, { time: 3.75, note: DRUM.snare, duration: 0.25, velocity: 0.6 }];

// Template 0: today's fixed bar (unchanged — creativity 0 must reproduce it bit for bit).
const drums0 = drumPattern({
  kick: [{ t: 0, p: 1 }, { t: 2.5, p: 1 }, { t: 3.75, p: 0.2 }],
  snare: [{ t: 1, p: 1, vel: 0.7 }, { t: 3, p: 1, vel: 0.7 }, { t: 3.5, p: 0.15, vel: 0.4 }],
  hat: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map(t => ({ t, p: 1, vel: t % 1 ? 0.35 : 0.55 })),
  openHat: [{ t: 3.5, p: 0.25, vel: 0.4 }],
}, drumFill);
// Template 1: dropped kick on the "and", snare pushed late.
const drums1 = drumPattern({
  kick: [{ t: 0, p: 1 }],
  snare: [{ t: 1.25, p: 1, vel: 0.7 }, { t: 3.25, p: 1, vel: 0.7 }],
  hat: [0, 1, 2, 3].map(t => ({ t, p: 1, vel: 0.5 })),
  openHat: [{ t: 1.5, p: 0.3, vel: 0.35 }, { t: 3.5, p: 0.3, vel: 0.35 }],
}, drumFill);
// Template 2: swung 8ths, extra ghost kick at 1.75.
const drums2 = drumPattern({
  kick: [{ t: 0, p: 1 }, { t: 1.75, p: 0.4 }, { t: 2.5, p: 1 }],
  snare: [{ t: 1, p: 1, vel: 0.7 }, { t: 3, p: 1, vel: 0.7 }],
  hat: [0, 0.583, 1, 1.583, 2, 2.583, 3, 3.583].map(t => ({ t, p: 1, vel: 0.4 })),
}, drumFill);

const bass0 = bassPattern([{ t: 0, degree: 0, p: 1, dur: 1.5 }, { t: 2, degree: 0, p: 0.6, dur: 0.5 }, { t: 2.5, degree: 4, p: 1, dur: 1 }, { t: 3.5, degree: 3, p: 0.3, dur: 0.5 }], 2);
// Template 1: simpler, half-note walk.
const bass1 = bassPattern([{ t: 0, degree: 0, p: 1, dur: 2 }, { t: 2, degree: 4, p: 1, dur: 2 }], 2);
// Template 2: syncopated, root anticipated on the "and" of 4 into the next bar's downbeat feel.
const bass2 = bassPattern([{ t: 0, degree: 0, p: 1, dur: 1 }, { t: 1.5, degree: 2, p: 0.8, dur: 0.5 }, { t: 2.5, degree: 4, p: 1, dur: 1 }, { t: 3.5, degree: 0, p: 0.5, dur: 0.5 }], 2);

export const lofi: Record<Instrument, Pattern> = {
  drums: withArrangement('drums', withDrumPhrasing(chooseTemplate([drums0, drums1, drums2]))),
  bass: withArrangement('bass', withBassApproach(chooseTemplate([bass0, bass1, bass2]), 2)),
  keys: withArrangement('keys', withSpaceAnswer(chordPattern([[0, 2, 4, 6], [3, 5, 7, 9], [5, 7, 9, 11], [4, 6, 8, 10]], [{ t: 0, p: 1, dur: 2 }, { t: 2.5, p: 1, dur: 1.5, vel: 0.6 }], 4), 4)),
  lead: withArrangement('lead', leadPattern([
    [{ t: 0.5, idx: 4, p: 1 }, { t: 1.5, idx: 3, p: 1 }, { t: 2.5, idx: 2, p: 0.7, dur: 1 }],
    [{ t: 1, idx: 5, p: 1, dur: 1 }, { t: 3, idx: 4, p: 0.8 }],
  ], 5)),
};
