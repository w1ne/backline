import type { BandState, Instrument } from '../types';

export interface BandEngine {
  start(bpm: number, firstBarAt: number): Promise<void>;
  stop(): void;
  set(p: Partial<Pick<BandState, 'genre' | 'key' | 'creativity'>>): void;
  setEnabled(i: Instrument, on: boolean): void;
  setBpm(bpm: number): void;
  onBar?: (bar: number) => void;
  /** ms until a control change is audible; UI shows "joining…" for this long */
  readonly changeLatencyMs: number;
}
