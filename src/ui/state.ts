import type { MonitorSound } from '../players/monitor';
import type { BandInput, Genre, Instrument } from '../types';
import { IDLE_DYNAMICS } from '../types';
import type { SourceStatus } from '../listener/listener';
import { MAIN_ROUTING, type RoutingState } from '../audio/routing';
import type { DeviceOption } from '../audio/devices';

export type EngineChoice = 'lyria' | 'patterns' | 'acestep' | 'amt';

export interface AppState {
  power: 'off' | 'on';
  sources: SourceStatus;
  genre: Genre;
  engine: EngineChoice;
  /** sound used to play the player's own MIDI keyboard */
  sound: MonitorSound;
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
  /** where each part goes: the main output, the MORPH output (Neutone/LYDIA), or both */
  routing: RoutingState;
  /** chosen MORPH output device, or null when the morph bus is off */
  morphOut: string | null;
  /** false where setSinkId() is missing (Firefox/Safari): the picker says so instead of lying */
  morphSupported: boolean;
  audioOutputs: DeviceOption[];
  /** chosen mic input, or null for the system default */
  micIn: string | null;
  audioInputs: DeviceOption[];
  /** chosen MIDI input id, or null for "all" */
  midiIn: string | null;
  midiInputs: DeviceOption[];
}

const defaults: AppState = {
  power: 'off',
  sources: { mic: 'off', midi: 'off' },
  genre: 'lofi',
  engine: 'acestep',
  sound: 'grand',
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
  routing: { ...MAIN_ROUTING },
  morphOut: null,
  morphSupported: true,
  audioOutputs: [],
  micIn: null,
  audioInputs: [],
  midiIn: null,
  midiInputs: [],
};

export class Store {
  state: AppState = {
    ...defaults,
    enabled: { ...defaults.enabled },
    input: { ...defaults.input, dynamics: { ...defaults.input.dynamics } },
    sources: { ...defaults.sources },
    offlineEngines: [...defaults.offlineEngines],
    routing: { ...defaults.routing },
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
