/** One entry in the keyboard-sound menu. */
export interface SoundDef {
  id: string;
  label: string;
  group: string;
  kind: 'grand' | 'ep' | 'mellotron' | 'soundfont' | 'synth';
  name?: string;
}

const sf = (id: string, label: string, group: string, name = id): SoundDef => ({ id, label, group, kind: 'soundfont', name });
const tron = (id: string, label: string, name: string): SoundDef => ({ id, label, group: 'Mellotron', kind: 'mellotron', name });

/** Curated keyboard sounds, grouped for the <select>. */
export const SOUNDS: readonly SoundDef[] = [
  sf('acoustic_grand_piano', 'Acoustic piano', 'Keys'),
  sf('electric_piano_1', 'Electric piano', 'Keys'),
  { id: 'grand', label: 'Grand piano', group: 'Keys', kind: 'grand' },
  { id: 'wurlitzer', label: 'Wurlitzer EP', group: 'Keys', kind: 'ep', name: 'WurlitzerEP200' },
  { id: 'cp80', label: 'CP-80 electric grand', group: 'Keys', kind: 'ep', name: 'CP80' },
  sf('clavinet', 'Clavinet', 'Keys'),
  sf('drawbar_organ', 'Hammond organ', 'Keys'),
  sf('rock_organ', 'Rock organ', 'Keys'),
  tron('tron_violins', 'MkII violins', 'MKII VIOLINS'),
  tron('tron_cello', 'Cello', 'TRON CELLO'),
  tron('tron_flute', 'Flute', 'TRON FLUTE'),
  tron('tron_choir', '8-voice choir', '8VOICE CHOIR'),
  tron('tron_brass', 'MkII brass', 'MKII BRASS'),
  tron('tron_sax', 'MkII sax', 'MKII SAX'),
  sf('violin', 'Violin', 'Orchestra'),
  sf('viola', 'Viola', 'Orchestra'),
  sf('cello', 'Cello', 'Orchestra'),
  sf('string_ensemble_1', 'String ensemble', 'Orchestra'),
  sf('pizzicato_strings', 'Pizzicato strings', 'Orchestra'),
  sf('orchestral_harp', 'Harp', 'Orchestra'),
  sf('flute', 'Flute', 'Orchestra'),
  sf('clarinet', 'Clarinet', 'Orchestra'),
  sf('oboe', 'Oboe', 'Orchestra'),
  sf('french_horn', 'French horn', 'Orchestra'),
  sf('alto_sax', 'Alto sax', 'Band'),
  sf('tenor_sax', 'Tenor sax', 'Band'),
  sf('trumpet', 'Trumpet', 'Band'),
  sf('trombone', 'Trombone', 'Band'),
  sf('harmonica', 'Harmonica', 'Band'),
  sf('acoustic_guitar_nylon', 'Nylon guitar', 'Guitars'),
  sf('acoustic_guitar_steel', 'Steel guitar', 'Guitars'),
  sf('electric_guitar_clean', 'Clean electric', 'Guitars'),
  sf('electric_guitar_jazz', 'Jazz guitar', 'Guitars'),
  sf('overdriven_guitar', 'Overdriven guitar', 'Guitars'),
  sf('vibraphone', 'Vibraphone', 'Mallets'),
  sf('marimba', 'Marimba', 'Mallets'),
  sf('kalimba', 'Kalimba', 'Mallets'),
  sf('lead_2_sawtooth', 'Saw lead', 'Synths'),
  sf('lead_1_square', 'Square lead', 'Synths'),
  sf('pad_2_warm', 'Warm pad', 'Synths'),
  sf('pad_3_polysynth', 'Polysynth pad', 'Synths'),
  sf('synth_brass_1', 'Synth brass', 'Synths'),
  sf('synth_strings_1', 'Synth strings', 'Synths'),
  sf('choir_aahs', 'Choir aahs', 'Synths'),
  ...[['synth_soft', 'Soft keys'], ['synth_bell', 'Bell keys'], ['synth_pluck', 'Pluck'], ['synth_pad', 'Warm pad'], ['synth_square', 'Square lead']].map(([id, label]): SoundDef => ({ id, label, group: 'Offline synths', kind: 'synth' })),
  { id: 'synth', label: 'Fat saw (built-in)', group: 'Synths', kind: 'synth' },
];
export const SOUND_GROUPS = [...new Set(SOUNDS.map(s => s.group))];
export const DEFAULT_SOUND = 'grand';
export type MonitorSound = string;
export function soundDef(id: MonitorSound): SoundDef {
  return SOUNDS.find(s => s.id === id) ?? SOUNDS[0];
}

