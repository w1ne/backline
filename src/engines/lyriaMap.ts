import type { Genre, Instrument, Key } from '../types';

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
  lead: { text: 'lead guitar melody', weight: 0.7 },
};

const INSTRUMENT_ORDER: Instrument[] = ['drums', 'bass', 'keys', 'lead'];

export function promptsFor(
  genre: Genre,
  enabled: Record<Instrument, boolean>,
): { text: string; weight: number }[] {
  const prompts = [{ text: GENRE_TEXT[genre], weight: 1 }];
  for (const i of INSTRUMENT_ORDER) {
    if (enabled[i]) prompts.push(INSTRUMENT_PROMPT[i]);
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
): LyriaConfig {
  return {
    bpm: Math.min(200, Math.max(60, bpm)),
    scale: scaleFor(key),
    temperature: 0.6 + creativity * 1.6,
    density: 0.3 + creativity * 0.5,
    muteDrums: !enabled.drums,
    muteBass: !enabled.bass,
  };
}
