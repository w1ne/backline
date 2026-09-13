/** Dirty-check for forwarding a follow-mode tempo change to a band engine: forward the
 * first value seen, or any value that differs from the last one sent by at least `step`. */
export function forwardBpm(prevSent: number | undefined, next: number, step: number): boolean {
  return prevSent === undefined || Math.abs(next - prevSent) >= step;
}

/** How long a different tempo has to hold before the band follows it, in ms: about four bars
 *  at a mid tempo, so a singer rushing one phrase does not drag the band, but a real change of
 *  pace does. */
export const SUSTAIN_MS = 8000;
/** how close consecutive estimates must be, in bpm, to count as "the same new tempo" */
export const SUSTAIN_TOLERANCE_BPM = 3;

/**
 * Follows a tempo estimate only once it has clearly and persistently moved: the new value must
 * differ from what the band plays by at least `step` and keep coming (within a tolerance) for
 * SUSTAIN_MS. Returns the bpm to forward, or undefined to hold. Pure apart from its own state.
 */
export class SustainedBpmFollower {
  private candidate?: number;
  private since = 0;

  constructor(readonly step: number, readonly sustainMs = SUSTAIN_MS, private tolerance = SUSTAIN_TOLERANCE_BPM) {}

  reset(): void {
    this.candidate = undefined;
  }

  observe(playing: number | undefined, estimate: number, nowMs: number): number | undefined {
    if (playing === undefined) return estimate;
    if (Math.abs(estimate - playing) < this.step) {
      this.candidate = undefined;
      return undefined;
    }
    if (this.candidate === undefined || Math.abs(estimate - this.candidate) > this.tolerance) {
      this.candidate = estimate;
      this.since = nowMs;
      return undefined;
    }
    if (nowMs - this.since >= this.sustainMs) {
      this.candidate = undefined;
      return estimate;
    }
    return undefined;
  }
}
