import type { BandState, Instrument } from '../types';
import type { MorphRoute } from '../audio/routing';

export interface BandEngine {
  start(bpm: number, firstBarAt: number): Promise<void>;
  stop(): void;
  /** `chordBeat` is the absolute beat the chord took effect on; engines that don't place
   *  notes on a beat grid ignore it. */
  set(p: Partial<Pick<BandState, 'genre' | 'key' | 'chord' | 'creativity' | 'dynamics'>> & { chordBeat?: number }): void;
  setEnabled(i: Instrument, on: boolean): void;
  setBpm(bpm: number): void;
  setAmount?(amount: number): void;
  /** smallest bpm change worth forwarding in follow mode */
  readonly bpmStep: number;
  onBar?: (bar: number, audioTime?: number) => void;
  /** called with a human-readable message when the engine hits an unrecoverable error */
  onError?: (msg: string) => void;
  /** called once the engine has actually produced/received its first audio block */
  onFirstBlock?: () => void;
  onConnected?: () => void;
  onStatus?: (message: string, latencyMs?: number) => void;
  /** periodic playback stats (e.g. Lyria's audio-buffer loop/underrun counters) */
  onStats?: (s: { loops: number; starvedSec: number }) => void;
  /** ms until a control change is audible; UI shows "joining…" for this long */
  readonly changeLatencyMs: number;
  /** Routes the engine's own audio stream to the main and/or MORPH output. Only the
   *  engines that render their own audio (Lyria, ACE) implement it — Patterns and AMT
   *  play through Players, where routing is per instrument. */
  routeBand?(route: MorphRoute, morphNode?: AudioNode): void;
  /** Audio engines expose a tap on their output so the visualiser can draw a spectrum.
   *  Only valid after start(); note-based engines don't implement it. */
  getAnalyser?(): AnalyserNode | undefined;
}
