import type { Dynamics, Genre, Instrument, Key } from '../types';
import { IDLE_DYNAMICS } from '../types';

const SCALE_NAMES = [
  'C_MAJOR_A_MINOR',
  'D_FLAT_MAJOR_B_FLAT_MINOR',
  'D_MAJOR_B_MINOR',
  'E_FLAT_MAJOR_C_MINOR',
  'E_MAJOR_D_FLAT_MINOR',
  'F_MAJOR_D_MINOR',
  'G_FLAT_MAJOR_E_FLAT_MINOR',
  'G_MAJOR_E_MINOR',
  'A_FLAT_MAJOR_F_MINOR',
  'A_MAJOR_G_FLAT_MINOR',
  'B_FLAT_MAJOR_G_MINOR',
  'B_MAJOR_A_FLAT_MINOR',
];

export function scaleFor(key: Key): string {
  const majorRoot = key.mode === 'minor' ? (key.root + 3) % 12 : key.root;
  return SCALE_NAMES[majorRoot];
}

const GENRE_TEXT: Record<Genre, string> = {
  lofi: 'lofi hip hop',
  funk: 'funk',
  rock: 'rock',
  jazz: 'jazz',
};

const INSTRUMENT_PROMPT: Record<Instrument, { text: string; weight: number }> = {
  drums: { text: 'drums', weight: 0.8 },
  bass: { text: 'bass guitar', weight: 0.8 },
  keys: { text: 'electric piano chords', weight: 0.7 },
  lead: { text: 'electric guitar lead', weight: 0.7 },
};

const INSTRUMENT_ORDER: Instrument[] = ['drums', 'bass', 'keys', 'lead'];

/** The lead is an answering voice: its prompt is only weighted in while the player has left
 *  space. Without dynamics (no listener yet) it behaves as it always did. */
export function promptsFor(
  genre: Genre,
  enabled: Record<Instrument, boolean>,
  dynamics?: Dynamics,
): { text: string; weight: number }[] {
  const prompts = [{ text: GENRE_TEXT[genre], weight: 1 }];
  for (const i of INSTRUMENT_ORDER) {
    if (!enabled[i]) continue;
    if (i === 'lead' && dynamics && !dynamics.space) continue;
    prompts.push(INSTRUMENT_PROMPT[i]);
  }
  return prompts;
}

export interface LyriaConfig {
  bpm: number;
  scale: string;
  temperature: number;
  density: number;
  muteDrums: boolean;
  muteBass: boolean;
}

export function configFor(
  bpm: number,
  key: Key,
  creativity: number,
  enabled: Record<Instrument, boolean>,
  dynamics: Dynamics = IDLE_DYNAMICS,
): LyriaConfig {
  const intensity = Math.min(1, Math.max(0, dynamics.intensity));
  return {
    bpm: Math.min(200, Math.max(60, bpm)),
    scale: scaleFor(key),
    // Creativity still owns how far the model wanders; how *much* it plays follows the
    // player, so the band thickens up with them and thins out when they stop.
    temperature: 0.6 + creativity * 1.6,
    density: 0.25 + intensity * 0.5,
    muteDrums: !enabled.drums,
    muteBass: !enabled.bass,
  };
}
