export interface ClockLike {
  start(bpm: number, firstBarAt: number): void;
  stop(): void;
  onBar(cb: (bar: number, barStartTime: number) => void): void;
  /** Optional: fires half a measure after each bar's downbeat, with the bar it belongs to and the
   *  audio time of the half-bar. Clocks with a real transport implement it so mid-bar cues do not
   *  depend on a timer a background tab would clamp. */
  onHalfBar?(cb: (bar: number, halfBarTime: number) => void): void;
  readonly bpm: number;
  setBpm(bpm: number): void;
}
