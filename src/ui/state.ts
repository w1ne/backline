import type { BandInput, Genre, Instrument } from '../types';

export const GEMINI_KEY_STORAGE = 'backline.geminiKey';

export type EngineChoice = 'lyria' | 'patterns';

export interface AppState {
  screen: 'setup' | 'live';
  source: 'mic' | 'midi';
  genre: Genre;
  engine: EngineChoice;
  creativity: number;
  enabled: Record<Instrument, boolean>;
  input: BandInput;
  locked: boolean;
  bar: number;
  error: string | null;
}

function hasStoredKey(): boolean {
  try {
    return !!localStorage.getItem(GEMINI_KEY_STORAGE);
  } catch {
    return false;
  }
}

const defaults: AppState = {
  screen: 'setup',
  source: 'midi',
  genre: 'lofi',
  engine: hasStoredKey() ? 'lyria' : 'patterns',
  creativity: 0.3,
  enabled: { drums: true, bass: false, keys: false, lead: false },
  input: { bpm: null, key: null, notesNow: [], inputLevel: 0, onsets: 0 },
  locked: false,
  bar: 0,
  error: null,
};

export class Store {
  state: AppState = { ...defaults, enabled: { ...defaults.enabled }, input: { ...defaults.input } };
  private cbs: ((s: AppState) => void)[] = [];

  update(p: Partial<AppState>): void {
    this.state = { ...this.state, ...p };
    this.cbs.forEach(cb => cb(this.state));
  }

  subscribe(cb: (s: AppState) => void): () => void {
    this.cbs.push(cb);
    return () => {
      this.cbs = this.cbs.filter(c => c !== cb);
    };
  }
}
