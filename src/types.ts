export type Instrument = 'drums' | 'bass' | 'keys' | 'lead';
export type Genre = 'lofi' | 'funk' | 'rock' | 'jazz';
export const INSTRUMENTS: Instrument[] = ['drums', 'bass', 'keys', 'lead'];
export const GENRES: Genre[] = ['lofi', 'funk', 'rock', 'jazz'];

export interface Key { root: number; mode: 'major' | 'minor' } // root 0=C … 11=B

export interface BandInput {
  bpm: number | null;
  key: Key | null;
  notesNow: number[];
  inputLevel: number;
}

export interface NoteEvent { time: number; note: number; duration: number; velocity: number }
export interface BarContext { bar: number; key: Key; creativity: number; rng: () => number }
export interface Pattern { nextBar(ctx: BarContext): NoteEvent[] }

export interface BandState {
  genre: Genre;
  key: Key;
  creativity: number;
  enabled: Record<Instrument, boolean>;
}

export const DRUM = { kick: 36, snare: 38, hat: 42, openHat: 46, crash: 49 } as const;
