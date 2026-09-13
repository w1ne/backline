import type { AccompPreset, Instrument } from '../types';

/** GM program number -> MusyngKite soundfont instrument name and the AMT accompaniment
 *  preset(s) it belongs to. Covers only the programs bench/amt/amt.py's INSTRUMENT_PRESETS
 *  actually uses; names match smplr's Soundfont instrument list (see src/players/monitor.ts). */
export const GM_INSTRUMENTS: Record<number, { name: string; role: Exclude<Instrument, 'drums'>; presets: AccompPreset[] }> = {
  4: { name: 'electric_piano_1', role: 'keys', presets: ['keys'] },
  24: { name: 'acoustic_guitar_nylon', role: 'lead', presets: ['guitar'] },
  40: { name: 'violin', role: 'keys', presets: ['strings', 'violin'] },
  41: { name: 'viola', role: 'keys', presets: ['strings'] },
  42: { name: 'cello', role: 'bass', presets: ['strings'] },
  46: { name: 'orchestral_harp', role: 'keys', presets: ['orchestral'] },
  48: { name: 'string_ensemble_1', role: 'keys', presets: ['orchestral'] },
  56: { name: 'trumpet', role: 'keys', presets: ['brass'] },
  65: { name: 'alto_sax', role: 'keys', presets: ['sax'] },
  73: { name: 'flute', role: 'keys', presets: ['ambient'] },
  88: { name: 'pad_2_warm', role: 'keys', presets: ['ambient'] },
};
