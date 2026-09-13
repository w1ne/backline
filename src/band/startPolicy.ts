/**
 * How a session gets its first tempo.
 *
 * A keyboard's onsets are beats, so the tempo detected from them starts the band. A solo
 * voice's onsets are syllables: on the real-voice songs the estimate came out 1.5-1.9x the
 * song's tempo on three of four, and the first five seconds hold no beat at all. So a mic-only
 * session with the count-in on does not adopt that estimate; it shows the syllable rate as a
 * hint and waits for a tempo the singer gives it, tapped or typed, then counts in from there.
 * Turning the count-in off restores the onset-driven start for anyone who wants it.
 */
export interface StartPolicyInput {
  /** the mic is on and no MIDI keyboard is */
  micOnly: boolean;
  /** the two-bar count-in is enabled (on by default) */
  countIn: boolean;
  /** the singer has tapped or typed a tempo */
  hasBpmOverride: boolean;
}

/** True while the band must not start from the detected tempo. */
export function waitsForGivenTempo(p: StartPolicyInput): boolean {
  return p.micOnly && p.countIn && !p.hasBpmOverride;
}

/** The syllable-rate estimate as the LCD shows it while waiting: a hint, not a tempo. */
export function tempoHint(pendingBpm: number | null): string {
  return pendingBpm ? `~${Math.round(pendingBpm)} spoken` : '';
}
