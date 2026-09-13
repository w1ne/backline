import type { MonitorSound } from '../players/monitor';
import type { AccompPreset, BandInput, Genre, Instrument } from '../types';
import { IDLE_DYNAMICS } from '../types';
import type { SourceStatus } from '../listener/listener';
import { MAIN_ROUTING, type RoutingState } from '../audio/routing';
import type { DeviceOption } from '../audio/devices';

export type EngineChoice = 'lyria' | 'patterns' | 'acestep' | 'amt';

export interface AppState {
  power: 'off' | 'on';
  accompanimentStatus: string;
  modelLatencyMs: number | null;
  responseLatencyMs: number | null;
  /** Server queue wait + request age for the last AMT plan, and plan notes dropped as too late. */
  queueLatencyMs: number | null;
  requestAgeMs: number | null;
  tooLate: number;
  activeParts: Partial<Record<Instrument, boolean>>;
  sources: SourceStatus;
  genre: Genre;
  engine: EngineChoice;
  /** sound used to play the player's own MIDI keyboard */
  sound: MonitorSound;
  noiseVolume: number;
  droneVolume: number;
  creativity: number;
  /** manual INTENSITY knob, 0..1: how much the band adds, folded into the auto activity intensity */
  intensity: number;
  /** the intensity the band actually uses this beat (auto × manual), shown on the INTENSITY bar */
  effectiveIntensity: number;
  enabled: Record<Instrument, boolean>;
  input: BandInput;
  locked: boolean;
  tempoMode: 'locked' | 'follow';
  /** play a two-bar count-in click before the band's first bar; default on, persisted */
  countIn: boolean;
  /** current count-in beat (1..4), or null when no count-in is playing */
  countInBeat: number | null;
  /** AudioContext.outputLatency (or baseLatency), read once the context is running */
  outputLatencyMs: number | null;
  /** AudioContext still waiting for the first user gesture */
  audioSuspended: boolean;
  bar: number;
  /** wall-clock ms when the current bar started; drives external beat displays (UNO Q hearts) */
  barStartedAt: number | null;
  error: string | null;
  /** the Record button is armed: notes are being collected for the MIDI download */
  recording: boolean;
  /** the band is held: no scheduling, the ambient drone/noise beds are muted, and mic/MIDI
   *  input is ignored until the performer lets the band play again */
  paused: boolean;
  /** a self-dismissing notice shown in the LCD-styled toast, or null when none is showing */
  toast: string | null;
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
  /** mic gated from the listener (onsets/pitch/level); MIDI is unaffected */
  micMuted: boolean;
  /** the singer's own mic monitored back through the vocal chain — off by default, and
   *  only ever actually audible when monitorAllowed() agrees it is safe */
  voiceMonitor: boolean;
  audioInputs: DeviceOption[];
  /** chosen MIDI input id, or null for "all" */
  midiIn: string | null;
  midiInputs: DeviceOption[];
  /** AMT: extra GM instrument presets mixed into the accompaniment, beyond the default strings */
  accompPresets: AccompPreset[];
  /** AMT: which accompaniment presets have an audible note right now, for the tiles' LEDs */
  accompActive: Partial<Record<AccompPreset, boolean>>;
}

const defaults: AppState = {
  power: 'off',
  accompanimentStatus: 'Listening',
  modelLatencyMs: null,
  responseLatencyMs: null,
  queueLatencyMs: null,
  requestAgeMs: null,
  tooLate: 0,
  activeParts: {},
  sources: { mic: 'off', midi: 'off' },
  genre: 'lofi',
  engine: 'amt',
  sound: 'grand',
  noiseVolume: 0,
  droneVolume: 0,
  creativity: 0.3,
  intensity: 0.5,
  effectiveIntensity: 0,
  enabled: { drums: true, bass: true, keys: true, lead: false },
  input: { bpm: null, key: null, chord: null, notesNow: [], pitch: null, inputLevel: 0, onsets: 0, pendingBpm: null, voiceBpm: null, dynamics: IDLE_DYNAMICS },
  locked: false,
  tempoMode: 'locked',
  countIn: true,
  countInBeat: null,
  outputLatencyMs: null,
  audioSuspended: false,
  bar: 0,
  barStartedAt: null,
  error: null,
  recording: false,
  paused: false,
  toast: null,
  loops: 0,
  loopsUpdatedAt: undefined,
  offlineEngines: [],
  engineConnecting: false,
  routing: { ...MAIN_ROUTING },
  morphOut: null,
  morphSupported: true,
  audioOutputs: [],
  micIn: null,
  micMuted: false,
  voiceMonitor: false,
  audioInputs: [],
  midiIn: null,
  midiInputs: [],
  accompPresets: ['strings'],
  accompActive: {},
};

export class Store {
  state: AppState = {
    ...defaults,
    enabled: { ...defaults.enabled },
    input: { ...defaults.input, dynamics: { ...defaults.input.dynamics } },
    sources: { ...defaults.sources },
    offlineEngines: [...defaults.offlineEngines],
    routing: { ...defaults.routing },
    accompPresets: [...defaults.accompPresets],
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
