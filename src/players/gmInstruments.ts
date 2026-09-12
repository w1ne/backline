import type { AccompPreset } from '../types';

/** GM program number -> MusyngKite soundfont instrument name and the AMT accompaniment
 *  preset(s) it belongs to. Covers only the programs bench/amt/amt.py's INSTRUMENT_PRESETS
 *  actually uses; names match smplr's Soundfont instrument list (see src/players/monitor.ts). */
export const GM_INSTRUMENTS: Record<number, { name: string; presets: AccompPreset[] }> = {
  4: { name: 'electric_piano_1', presets: ['keys'] },
  24: { name: 'acoustic_guitar_nylon', presets: ['guitar'] },
  40: { name: 'violin', presets: ['strings', 'violin'] },
  41: { name: 'viola', presets: ['strings'] },
  42: { name: 'cello', presets: ['strings'] },
  46: { name: 'orchestral_harp', presets: ['orchestral'] },
  48: { name: 'string_ensemble_1', presets: ['orchestral'] },
  56: { name: 'trumpet', presets: ['brass'] },
  65: { name: 'alto_sax', presets: ['sax'] },
  73: { name: 'flute', presets: ['ambient'] },
  88: { name: 'pad_2_warm', presets: ['ambient'] },
};
