import type { BandInput, Genre, Instrument } from '../types';
import { IDLE_DYNAMICS } from '../types';
import type { SourceStatus } from '../listener/listener';

export type EngineChoice = 'lyria' | 'patterns' | 'acestep' | 'amt';

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
  loops: number;
  loopsUpdatedAt: number | undefined;
  /** engines the /health probe found unreachable at page load; still selectable, just flagged in the UI */
  offlineEngines: EngineChoice[];
  /** true while the current engine is waiting on its 8s connect/first-block watchdog */
  engineConnecting: boolean;
}

const defaults: AppState = {
  power: 'off',
  sources: { mic: 'off', midi: 'off' },
  genre: 'lofi',
  engine: 'acestep',
  creativity: 0.3,
  enabled: { drums: true, bass: false, keys: false, lead: false },
  input: { bpm: null, key: null, chord: null, notesNow: [], pitch: null, inputLevel: 0, onsets: 0, pendingBpm: null, dynamics: IDLE_DYNAMICS },
  locked: false,
  tempoMode: 'locked',
  bar: 0,
  error: null,
  loops: 0,
  loopsUpdatedAt: undefined,
  offlineEngines: [],
  engineConnecting: false,
};

export class Store {
  state: AppState = {
    ...defaults,
    enabled: { ...defaults.enabled },
    input: { ...defaults.input, dynamics: { ...defaults.input.dynamics } },
    sources: { ...defaults.sources },
    offlineEngines: [...defaults.offlineEngines],
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
