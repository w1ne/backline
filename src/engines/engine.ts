import type { BandState, Instrument } from '../types';

export interface BandEngine {
  start(bpm: number, firstBarAt: number): Promise<void>;
  stop(): void;
  set(p: Partial<Pick<BandState, 'genre' | 'key' | 'creativity'>>): void;
  setEnabled(i: Instrument, on: boolean): void;
  setBpm(bpm: number): void;
  /** smallest bpm change worth forwarding in follow mode */
  readonly bpmStep: number;
  onBar?: (bar: number) => void;
  /** called with a human-readable message when the engine hits an unrecoverable error */
  onError?: (msg: string) => void;
  /** periodic playback stats (e.g. Lyria's audio-buffer loop/underrun counters) */
  onStats?: (s: { loops: number; starvedSec: number }) => void;
  /** ms until a control change is audible; UI shows "joining…" for this long */
  readonly changeLatencyMs: number;
}
