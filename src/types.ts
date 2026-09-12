export type Instrument = 'drums' | 'bass' | 'keys' | 'lead';
export type Genre = 'lofi' | 'funk' | 'rock' | 'jazz';
export const INSTRUMENTS: Instrument[] = ['drums', 'bass', 'keys', 'lead'];
export const GENRES: Genre[] = ['lofi', 'funk', 'rock', 'jazz'];

export interface Key { root: number; mode: 'major' | 'minor' } // root 0=C … 11=B

export type ChordQuality = 'maj' | 'min' | 'dom7' | 'min7' | 'maj7' | 'sus4' | 'dim';
export interface Chord { root: number; quality: ChordQuality } // root 0=C … 11=B

export interface BandInput {
  bpm: number | null;
  key: Key | null;
  /** chord the player is currently outlining, re-decided every half bar; null until one settles */
  chord: Chord | null;
  notesNow: number[];
  /** current stable pitch reading, or null when silent/unstable */
  pitch: { midi: number; cents: number; stable: boolean } | null;
  inputLevel: number;
  onsets: number;
  /** read-only running estimate from the onsets so far, shown while still listening */
  pendingBpm: number | null;
}

export interface NoteEvent { time: number; note: number; duration: number; velocity: number }
export interface BarContext {
  bar: number;
  key: Key;
  /** chord for the bar; defaults to the key's tonic triad when absent */
  chord?: Chord;
  /** chord in force at `beat` within the bar, so a hit after a mid-bar change follows it */
  chordAt?: (beat: number) => Chord;
  creativity: number;
  rng: () => number;
}
export interface Pattern { nextBar(ctx: BarContext): NoteEvent[] }

export interface BandState {
  genre: Genre;
  key: Key;
  chord: Chord | null;
  creativity: number;
  enabled: Record<Instrument, boolean>;
}

export const DRUM = { kick: 36, snare: 38, hat: 42, openHat: 46, crash: 49 } as const;
