# Voice listener bench results

Generated 2026-09-12 by bench/voice/run.ts.

## Pitch, note detection, key/tempo lock

| clip | profile | pitch acc % | octave err % | note P | note R | note F1 | latency ms | key lock s | key ok | tempo lock s | bpm err |
|---|---|---|---|---|---|---|---|---|---|---|---|
| sustained-C3 | VOICE | 97.5 | 0.0 | 1.00 | 1.00 | 1.00 | 152 | — | — | — | — |
| sustained-C3 | INSTRUMENT | 97.5 | 0.0 | 1.00 | 1.00 | 1.00 | 259 | — | — | — | — |
| sustained-A3 | VOICE | 100.0 | 0.0 | 1.00 | 1.00 | 1.00 | 109 | — | — | — | — |
| sustained-A3 | INSTRUMENT | 100.0 | 0.0 | 1.00 | 1.00 | 1.00 | 205 | — | — | — | — |
| sustained-E4 | VOICE | 100.0 | 0.0 | 1.00 | 1.00 | 1.00 | 109 | — | — | — | — |
| sustained-E4 | INSTRUMENT | 100.0 | 0.0 | 1.00 | 1.00 | 1.00 | 205 | — | — | — | — |
| sustained-A4 | VOICE | 100.0 | 0.0 | 1.00 | 1.00 | 1.00 | 109 | — | — | — | — |
| sustained-A4 | INSTRUMENT | 100.0 | 0.0 | 1.00 | 1.00 | 1.00 | 205 | — | — | — | — |
| scale-vib0-port0 | VOICE | 92.7 | 0.0 | 1.00 | 1.00 | 1.00 | 105 | 2.86 | — | — | — |
| scale-vib0-port0 | INSTRUMENT | 92.7 | 0.0 | 1.00 | 1.00 | 1.00 | 157 | 3.01 | — | — | — |
| scale-vib0-port60 | VOICE | 88.5 | 0.0 | 1.00 | 1.00 | 1.00 | 155 | 2.95 | — | — | — |
| scale-vib0-port60 | INSTRUMENT | 88.5 | 0.0 | 1.00 | 1.00 | 1.00 | 201 | 2.95 | — | — | — |
| scale-vib40-port0 | VOICE | 92.7 | 0.0 | 1.00 | 1.00 | 1.00 | 108 | 2.95 | — | — | — |
| scale-vib40-port0 | INSTRUMENT | 92.7 | 0.0 | 1.00 | 1.00 | 1.00 | 159 | 2.90 | — | — | — |
| scale-vib40-port60 | VOICE | 88.5 | 0.0 | 0.89 | 1.00 | 0.94 | 157 | 2.86 | — | — | — |
| scale-vib40-port60 | INSTRUMENT | 88.5 | 0.0 | 1.00 | 1.00 | 1.00 | 204 | 2.95 | — | — | — |
| scale-vib100-port0 | VOICE | 40.6 | 0.0 | 0.39 | 0.88 | 0.54 | 203 | 3.85 | — | — | — |
| scale-vib100-port0 | INSTRUMENT | 40.6 | 0.0 | 0.67 | 1.00 | 0.80 | 259 | 2.51 | — | — | — |
| scale-vib100-port60 | VOICE | 38.5 | 0.0 | 0.44 | 0.88 | 0.58 | 205 | 4.11 | — | — | — |
| scale-vib100-port60 | INSTRUMENT | 38.5 | 0.0 | 0.55 | 0.75 | 0.63 | 352 | 2.95 | — | — | — |
| melody-A3-root | VOICE | 87.4 | 0.0 | 0.97 | 0.91 | 0.94 | 125 | 3.20 | yes | 7.61 | -0.2 |
| melody-A3-root | INSTRUMENT | 87.4 | 0.0 | 0.93 | 0.88 | 0.90 | 205 | 4.26 | yes | 7.61 | -0.2 |
| arpeggio-Am-progression | VOICE | 89.5 | 0.0 | 0.97 | 1.00 | 0.98 | 136 | 3.01 | yes | 7.61 | -0.2 |
| arpeggio-Am-progression | INSTRUMENT | 89.5 | 0.0 | 1.00 | 1.00 | 1.00 | 205 | 3.05 | yes | 7.61 | -0.2 |
| melody-A2-root-low | VOICE | 86.9 | 0.0 | 0.85 | 0.88 | 0.86 | 125 | 3.20 | yes | 6.95 | -0.1 |
| melody-A2-root-low | INSTRUMENT | 86.9 | 0.0 | 0.90 | 0.88 | 0.89 | 216 | 3.31 | yes | 6.95 | -0.1 |
| melody-A4-root-high | VOICE | 87.8 | 0.0 | 0.97 | 0.91 | 0.94 | 125 | 3.20 | yes | 9.61 | -0.2 |
| melody-A4-root-high | INSTRUMENT | 87.8 | 0.0 | 0.94 | 0.91 | 0.92 | 205 | 4.26 | yes | 9.61 | -0.2 |

## False notes on the spoken (no stable pitch) clip

| profile | false notes emitted (truth = 0) |
|---|---|
| VOICE | 18 |
| INSTRUMENT | 11 |

## Candidate VOICE_PROFILE tweak (not applied to src/)

`{ holdFrames: 2, minClarity: 0.7, minAgree: 2 }` instead of the current `{ holdFrames: 3, minClarity: 0.7, minAgree: 2 }`:

| profile | mean note F1 on the three melody clips | false notes on spoken clip |
|---|---|---|
| current VOICE_PROFILE | 0.91 | 18 |
| candidate (holdFrames 2) | 0.87 | 17 |

Two frames of agreement (100 ms) instead of three: fewer false notes on the spoken clip, but a much lower note F1 on the melodies now that the tracker holds a note through short dropouts. Not applied. Checked against synthetic voices only; real recordings may move both numbers.

## What this means

**Pitch accuracy %** is the share of 50ms analysis windows, while a ground-truth note is sounding, where the raw McLeod pitch estimate (before the tracker's smoothing) lands within 50 cents of the true note. Low numbers on a clip mean the detector is landing on the wrong pitch (or nothing) most of the time it's supposed to be tracking a note, not just occasionally.

**Octave err %** is how often the miss above is specifically an octave (half or double the true frequency), which is a McLeod-family failure mode. If this number is high while accuracy is low, the fix is octave correction, not a better pitch estimator.

**Note P/R/F1** treat a detected note as correct only if it has the true note's midi number and lands within 400 ms of when that note actually started, which covers the pipeline's own latency (85 ms window, 50 ms poll, three frames of agreement) so that latency is measured rather than scored as a miss. Precision drops when the tracker emits notes that are not there (chatter); recall drops when it misses real notes (too slow to lock in, or locks on the wrong pitch).

**Latency ms** is the median delay, across correctly matched notes, between a note actually starting and the tracker reporting it. This is holdFrames worth of 50ms polls plus whatever time McLeod itself needs, so it has a floor set by the profile (VOICE: 3 frames, INSTRUMENT: 5).

**Key lock s / key ok** is how many seconds of audio it took KeyDetector to report a non-null key, and whether that key is the right one. **Tempo lock s / bpm err** is the same for TempoLock (needs 12 onsets before it commits) and how far its bpm estimate is from the truth once locked.

**False notes on the spoken clip** is a leak check: random pitch drift with no stable notes should produce zero detected notes. Any nonzero count here is the tracker hallucinating pitch out of speech-like noise, which would show up live as random unwanted notes while someone talks near the mic.
