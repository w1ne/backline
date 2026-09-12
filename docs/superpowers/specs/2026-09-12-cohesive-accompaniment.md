# Cohesive ACE and AMT accompaniment

The performer owns the melody. Accompaniment supports it while the performer plays,
and offers a short answering phrase in a gap. Soft playing alone is not a gap.

## Corrections

- AMT input timestamps originate on the performance clock, while the bar origin uses
  the AudioContext clock. Map the clocks at session start. Flush notes before bar
  requests, detach listeners on stop, and discard old-session input on restart.
- AMT's old committer trimmed model history but returned untrimmed playback durations.
  Shape notes before committing: quarter-note spacing under the performer, eighth-note
  spacing for a two-beat answer, followed by room for the next phrase. Trim durations
  at the next note and the window boundary. Preserve model-tick downbeats at uneven tempos.
- AMT bass follows the detected chord (or key tonic) in octave 2, rather than naming
  the most common generated melody pitch as the chord root. Apply incoming key, chord,
  space and creativity settings; use quieter accompaniment velocities.
- ACE `complete` adds instruments to source material. Recursively using the previous
  full mix as its source is not temporal continuation. Preserve one previous bar, append
  a silent two-bar interval, repaint that interval, and return only the new audio.
  Release temporary source files when generation finishes. Reject truncated output.
- ACE asks for a restrained recurring groove and a brief lead answer only when the lead
  is enabled and there is a gap. Low input intensity alone no longer selects a lead fill.

## Verification

Regression tests cover clock offset (beat 1 previously became beat 1981), input flush
ordering, restart contamination, soft-playing fill gating, actual playback overlap,
answer length, bass harmony, rounded downbeats at 133 BPM, continuation crop/length,
and muted-lead prompt contradictions.

Staged GPU checks on 2026-09-12:

- ACE: three consecutive four-second blocks; generation 2237, 2024 and 2018 ms.
  The captured 12-second file is `/tmp/backline-ace-continuation.wav` on this PC.
- AMT: a C-major test phrase produced one initial empty window followed by valid
  monophonic keys plans and C2 bass. Non-empty windows generated in about 131 ms.
  The later two-beat answer cap and 133 BPM correction have separate regression coverage.

These checks establish orchestration and timing, not perceived musical quality. ACE
still receives tempo/key/chord/activity summaries, not the performer's raw audio or
complete melody. AMT still represents input notes with a fixed half-beat duration.
AMT plans the next bar; ACE requests two-bar blocks. Already scheduled phrases cannot
instantly yield when the performer resumes. Listening with real input remains required.

Pinned ACE reference: https://github.com/ace-step/ACE-Step-1.5/blob/ca1e85fe9430179831e6bc6be790c332190a3866/docs/en/INFERENCE.md
