export type Instrument = 'drums' | 'bass' | 'keys' | 'lead';
export type Genre = 'lofi' | 'funk' | 'rock' | 'jazz';
export const INSTRUMENTS: Instrument[] = ['drums', 'bass', 'keys', 'lead'];
export const GENRES: Genre[] = ['lofi', 'funk', 'rock', 'jazz'];

/** AMT-only GM instrument presets the model may mix into its accompaniment. Names match
 *  services/amt/instruments.py's TOGGLEABLE_PRESETS (bench/amt/amt.py's INSTRUMENT_PRESETS). */
export type AccompPreset = 'strings' | 'violin' | 'guitar' | 'sax' | 'brass' | 'keys' | 'orchestral' | 'ambient';
/** The presets exposed as instrument tiles; the others (violin/guitar/brass/keys) are still
 *  valid server-side but not surfaced in the UI. */
export const ACCOMP_ROW: AccompPreset[] = ['sax', 'strings', 'orchestral', 'ambient'];

export interface Key { root: number; mode: 'major' | 'minor' | 'dorian' | 'mixolydian' } // root 0=C … 11=B

export type ChordQuality =
  | 'maj' | 'min' | 'dom7' | 'min7' | 'maj7' | 'sus4' | 'dim'
  | 'maj6' | 'min6' | 'dom9' | 'maj9' | 'min9' | 'add9' | 'dim7' | 'aug';
/** `bass`, when present, is the pitch class (0-11) actually sounding underneath the chord,
 *  when it differs from `root` — an inversion/slash chord (e.g. C major over a G bass). */
export interface Chord { root: number; quality: ChordQuality; bass?: number } // root/bass 0=C … 11=B

/** How the player is playing right now, measured per beat by the ActivityTracker. */
export interface Dynamics {
  /** 0 = not playing, 1 = playing flat out; attacks in a beat, releases over ~2 bars */
  intensity: number;
  /** the player has left a gap long enough for the band to answer in */
  space: boolean;
  /** this bar is the last of a four-bar group and the player is quiet enough for a fill */
  fillDue: boolean;
  /** beats since the player's last onset */
  silenceBeats: number;
}

export const IDLE_DYNAMICS: Dynamics = { intensity: 0, space: false, fillDue: false, silenceBeats: 0 };

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
  /** a singer's beat from the flux tempogram (mic only), available after ~8 s of singing */
  voiceBpm: number | null;
  /** the player's activity, updated on every beat */
  dynamics: Dynamics;
}

/** Which song section is in force for a bar, so patterns can shape themselves around the
 *  song's form instead of looping the same groove forever. All four are mutually exclusive;
 *  none set means an ordinary groove bar. See src/band/form.ts for the state machine that
 *  produces this. */
export interface Arrangement { intro: boolean; lift: boolean; breakdown: boolean; ending: boolean }

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
  /** what the player is doing; absent means "no listener", and patterns play their static form */
  dynamics?: Dynamics;
  /** the song's current section; absent means "no form", and patterns play their ordinary groove */
  arrangement?: Arrangement;
  /** Explicit, caller-owned scratch space for stateful voicing decisions (e.g. voice-led
   *  chord pitches), keyed per track so it can be threaded across bars without a module-level
   *  mutable global. Absent means "no memory" — a pattern falls back to a fresh voicing. */
  voicingMemo?: Record<string, number[]>;
  /** Ceiling (MIDI) the keys comping should stay under, so it sits below a singer's range.
   *  Absent means "no ceiling" — a pattern uses its own written range. */
  keysHigh?: number;
  /** The singer's current stable pitch class (0-11), when the chord was inferred from a mic
   *  rather than a MIDI keyboard. Absent means "no held note to avoid". */
  sungPitchClass?: number;
}
export interface Pattern { nextBar(ctx: BarContext): NoteEvent[] }

export interface BandState {
  genre: Genre;
  key: Key;
  chord: Chord | null;
  creativity: number;
  enabled: Record<Instrument, boolean>;
  dynamics: Dynamics;
  /** Where the chord/key came from: a MIDI keyboard (full triads/sevenths are safe) or the
   *  mic (a sung melody note is present, so comping needs to stay out of its way). Defaults
   *  to 'midi' when absent. */
  source?: 'midi' | 'mic';
  /** The singer's current stable pitch class (0-11), threaded through so comping patterns can
   *  avoid clashing with the held note. Only meaningful when `source` is 'mic'. */
  sungPitchClass?: number;
}

export const DRUM = { kick: 36, snare: 38, hat: 42, openHat: 46, crash: 49 } as const;
