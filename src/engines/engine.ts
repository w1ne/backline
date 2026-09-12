import type { BandState, Instrument } from '../types';

export interface BandEngine {
  start(bpm: number, firstBarAt: number): Promise<void>;
  stop(): void;
  /** `chordBeat` is the absolute beat the chord took effect on; engines that don't place
   *  notes on a beat grid ignore it. */
  set(p: Partial<Pick<BandState, 'genre' | 'key' | 'chord' | 'creativity'>> & { chordBeat?: number }): void;
  setEnabled(i: Instrument, on: boolean): void;
  setBpm(bpm: number): void;
  /** smallest bpm change worth forwarding in follow mode */
  readonly bpmStep: number;
  onBar?: (bar: number) => void;
  /** called with a human-readable message when the engine hits an unrecoverable error */
  onError?: (msg: string) => void;
  /** called once the engine has actually produced/received its first audio block */
  onFirstBlock?: () => void;
  /** periodic playback stats (e.g. Lyria's audio-buffer loop/underrun counters) */
  onStats?: (s: { loops: number; starvedSec: number }) => void;
  /** ms until a control change is audible; UI shows "joining…" for this long */
  readonly changeLatencyMs: number;
}
