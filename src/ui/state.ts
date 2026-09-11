import type { BandInput, Genre, Instrument } from '../types';
import type { SourceStatus } from '../listener/listener';

export type EngineChoice = 'lyria' | 'patterns';

export interface AppState {
  power: 'off' | 'on';
  sources: SourceStatus;
  genre: Genre;
  engine: EngineChoice;
  creativity: number;
  enabled: Record<Instrument, boolean>;
  input: BandInput;
  locked: boolean;
  tempoMode: 'locked' | 'follow';
  bar: number;
  error: string | null;
  user: { login: string } | null;
  loops: number;
  loopsUpdatedAt: number | undefined;
}

const defaults: AppState = {
  power: 'off',
  sources: { mic: 'off', midi: 'off' },
  genre: 'lofi',
  engine: 'patterns',
  creativity: 0.3,
  enabled: { drums: true, bass: false, keys: false, lead: false },
  input: { bpm: null, key: null, notesNow: [], inputLevel: 0, onsets: 0 },
  locked: false,
  tempoMode: 'locked',
  bar: 0,
  error: null,
  user: null,
  loops: 0,
  loopsUpdatedAt: undefined,
};

export class Store {
  state: AppState = {
    ...defaults,
    enabled: { ...defaults.enabled },
    input: { ...defaults.input },
    sources: { ...defaults.sources },
  };
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
