# Voice listener bench results

Generated 2026-09-12 by bench/voice/run.ts.

## Pitch, note detection, key/tempo lock

| clip | profile | pitch acc % | octave err % | note P | note R | note F1 | latency ms | key lock s | key ok | tempo lock s | bpm err |
|---|---|---|---|---|---|---|---|---|---|---|---|
| sustained-C3 | VOICE | 97.5 | 0.0 | 0.00 | 0.00 | — | — | — | — | — | — |
| sustained-C3 | INSTRUMENT | 97.5 | 0.0 | 0.00 | 0.00 | — | — | — | — | — | — |
| sustained-A3 | VOICE | 97.5 | 0.0 | 0.00 | 0.00 | — | — | — | — | — | — |
| sustained-A3 | INSTRUMENT | 97.5 | 0.0 | 0.00 | 0.00 | — | — | — | — | — | — |
| sustained-E4 | VOICE | 100.0 | 0.0 | 1.00 | 1.00 | 1.00 | 109 | — | — | — | — |
| sustained-E4 | INSTRUMENT | 100.0 | 0.0 | 0.00 | 0.00 | — | — | — | — | — | — |
| sustained-A4 | VOICE | 100.0 | 0.0 | 1.00 | 1.00 | 1.00 | 109 | — | — | — | — |
| sustained-A4 | INSTRUMENT | 100.0 | 0.0 | 0.00 | 0.00 | — | — | — | — | — | — |
| scale-vib0-port0 | VOICE | 91.7 | 0.0 | 0.75 | 0.75 | 0.75 | 104 | 4.50 | — | — | — |
| scale-vib0-port0 | INSTRUMENT | 91.7 | 0.0 | 0.00 | 0.00 | — | — | 4.55 | — | — | — |
| scale-vib0-port60 | VOICE | 87.5 | 0.0 | 0.38 | 0.38 | 0.38 | 101 | 4.50 | — | — | — |
| scale-vib0-port60 | INSTRUMENT | 87.5 | 0.0 | 0.00 | 0.00 | — | — | 4.55 | — | — | — |
| scale-vib40-port0 | VOICE | 91.7 | 0.0 | 0.63 | 0.63 | 0.63 | 104 | 4.50 | — | — | — |
| scale-vib40-port0 | INSTRUMENT | 91.7 | 0.0 | 0.00 | 0.00 | — | — | 4.55 | — | — | — |
| scale-vib40-port60 | VOICE | 86.5 | 0.0 | 0.22 | 0.25 | 0.24 | 101 | 4.00 | — | — | — |
| scale-vib40-port60 | INSTRUMENT | 86.5 | 0.0 | 0.00 | 0.00 | — | — | 4.55 | — | — | — |
| scale-vib100-port0 | VOICE | 7.3 | 0.0 | 0.00 | 0.00 | — | — | — | — | — | — |
| scale-vib100-port0 | INSTRUMENT | 7.3 | 0.0 | — | 0.00 | — | — | — | — | — | — |
| scale-vib100-port60 | VOICE | 6.3 | 0.0 | 0.00 | 0.00 | — | — | — | — | — | — |
| scale-vib100-port60 | INSTRUMENT | 6.3 | 0.0 | 0.00 | 0.00 | — | — | — | — | — | — |
| melody-A3-root | VOICE | 71.4 | 0.0 | 0.16 | 0.16 | 0.16 | 93 | 5.76 | yes | 7.61 | -0.2 |
| melody-A3-root | INSTRUMENT | 71.4 | 0.0 | 0.17 | 0.13 | 0.14 | 136 | 5.86 | yes | 7.61 | -0.2 |
| melody-A2-root-low | VOICE | 46.1 | 0.0 | 0.13 | 0.09 | 0.11 | 93 | 4.91 | yes | 6.95 | -0.1 |
| melody-A2-root-low | INSTRUMENT | 46.1 | 0.0 | 0.17 | 0.06 | 0.09 | 136 | 6.10 | no | 6.95 | -0.1 |
| melody-A4-root-high | VOICE | 80.8 | 0.0 | 0.26 | 0.25 | 0.25 | 93 | 5.71 | yes | 10.15 | -0.2 |
| melody-A4-root-high | INSTRUMENT | 80.8 | 0.0 | 0.19 | 0.16 | 0.17 | 136 | 5.80 | yes | 10.15 | -0.2 |

## False notes on the spoken (no stable pitch) clip

| profile | false notes emitted (truth = 0) |
|---|---|
| VOICE | 28 |
| INSTRUMENT | 12 |

## Candidate VOICE_PROFILE tweak (not applied to src/)

`{ holdFrames: 2, minClarity: 0.7, minAgree: 2 }` instead of the current `{ holdFrames: 3, minClarity: 0.7, minAgree: 2 }`:

| profile | mean note F1 on the three melody clips | false notes on spoken clip |
|---|---|---|
| current VOICE_PROFILE | 0.17 | 28 |
| candidate (holdFrames 2) | 0.23 | 22 |

Dropping holdFrames from 3 to 2 (100ms of agreement instead of 150ms) raises mean note F1 on the melody clips and does not add false notes on the spoken clip in this bench, reporting fewer instead. This is reported as a finding only, not applied to src/, and should be checked against real recordings before changing the shipped profile, since this bench uses a synthetic noise model.

## What this means

**Pitch accuracy %** is the share of 50ms analysis windows, while a ground-truth note is sounding, where the raw McLeod pitch estimate (before the tracker's smoothing) lands within 50 cents of the true note. Low numbers on a clip mean the detector is landing on the wrong pitch (or nothing) most of the time it's supposed to be tracking a note, not just occasionally.

**Octave err %** is how often the miss above is specifically an octave (half or double the true frequency), which is a McLeod-family failure mode. If this number is high while accuracy is low, the fix is octave correction, not a better pitch estimator.

**Note P/R/F1** treat a detected note as correct only if it has the true note's midi number and lands within 150ms of when that note actually started. Precision drops when the tracker emits notes that are not there (chatter); recall drops when it misses real notes (too slow to lock in, or locks on the wrong pitch).

**Latency ms** is the median delay, across correctly matched notes, between a note actually starting and the tracker reporting it. This is holdFrames worth of 50ms polls plus whatever time McLeod itself needs, so it has a floor set by the profile (VOICE: 3 frames, INSTRUMENT: 5).

**Key lock s / key ok** is how many seconds of audio it took KeyDetector to report a non-null key, and whether that key is the right one. **Tempo lock s / bpm err** is the same for TempoLock (needs 12 onsets before it commits) and how far its bpm estimate is from the truth once locked.

**False notes on the spoken clip** is a leak check: random pitch drift with no stable notes should produce zero detected notes. Any nonzero count here is the tracker hallucinating pitch out of speech-like noise, which would show up live as random unwanted notes while someone talks near the mic.
