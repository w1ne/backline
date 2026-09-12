/** The bits of AudioContext this needs; a plain object satisfies it in tests. */
export interface LatencySource {
  outputLatency?: number;
  baseLatency?: number;
}

/** Clock conversion has no scheduling lookahead. Only audio playback compensates
 * hardware latency; note visualization/export retains the captured timestamp. */
export function performanceAudioOffset(audioNow: number, performanceNow: number): number {
  return audioNow - performanceNow;
}

/**
 * outputLatency (seconds from a scheduled sample to the speaker) in milliseconds, falling
 * back to baseLatency where the browser doesn't report it (Safari), then to 0.
 */
export function outputLatencyMs(ctx: LatencySource): number {
  const sec = ctx.outputLatency ?? ctx.baseLatency ?? 0;
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : 0;
}
