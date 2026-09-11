import type { BandInput, Genre, Instrument } from '../types';

export interface AppState {
  screen: 'setup' | 'live';
  source: 'mic' | 'midi';
  genre: Genre;
  creativity: number;
  enabled: Record<Instrument, boolean>;
  input: BandInput;
  locked: boolean;
  bar: number;
}

const defaults: AppState = {
  screen: 'setup',
  source: 'midi',
  genre: 'lofi',
  creativity: 0.3,
  enabled: { drums: true, bass: false, keys: false, lead: false },
  input: { bpm: null, key: null, notesNow: [], inputLevel: 0 },
  locked: false,
  bar: 0,
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
