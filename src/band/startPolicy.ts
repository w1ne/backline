/**
 * How a session gets its first tempo.
 *
 * A keyboard's onsets are beats, so the tempo detected from them starts the band. A solo
 * voice's onsets are syllables, so the singer's tempo comes from the flux tempogram instead
 * (src/listener/tempoFromVoice.ts): after 8 s of singing it is within 8% of the song's tempo
 * or an exact octave of it on about two thirds of real songs (bench/tempo/RESULTS.md), and
 * nothing in the signal says which third a given song is in: a wrong estimate is as steady as
 * a right one. So a mic-only session with the count-in on still waits for a tempo the singer
 * gives it, tapped or typed, and shows the estimate as the suggestion to tap or confirm; the
 * onset-driven start with the count-in off uses the estimate directly.
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

/**
 * The estimate as the LCD shows it while waiting: the tempogram's beat once it has one
 * ("~96"), before that the onsets' syllable rate, marked as such ("~140 spoken").
 */
export function tempoHint(pendingBpm: number | null, voiceBpm: number | null = null): string {
  if (voiceBpm) return `~${Math.round(voiceBpm)}`;
  return pendingBpm ? `~${Math.round(pendingBpm)} spoken` : '';
}
