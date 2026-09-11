export interface ClockLike {
  start(bpm: number, firstBarAt: number): void;
  stop(): void;
  onBar(cb: (bar: number, barStartTime: number) => void): void;
  readonly bpm: number;
  setBpm(bpm: number): void;
}
