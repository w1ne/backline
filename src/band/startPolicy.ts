/** Select the existing beat clock's initial tempo; silence never starts a voice session. */
export function initialTempo(input: {
  micOnly: boolean;
  stablePitch: boolean;
  bpm: number | null;
  voiceBpm: number | null;
}): number | null {
  const valid = (bpm: number | null): bpm is number => bpm != null && Number.isFinite(bpm) && bpm > 0;
  if (valid(input.bpm)) return input.bpm;
  if (!input.micOnly || !input.stablePitch) return null;
  // A held vocal note contains no beat estimate. Supply a count-in at a usable tempo
  // instead of blocking accompaniment indefinitely; tapping/typing remains available.
  return valid(input.voiceBpm) ? input.voiceBpm : 100;
}
