# Listener calibration (MIR-1K)

Generated 2026-09-13 by bench/calibrate/run.ts in 43s. Calibration: 16 clips (amy, Ani, ariel, titon, abjones, davidson, geniusturtle, leon). Held out: 8 clips (heycat, yifen, jmzen, Kenshin). Stage 1: 48 tracker evaluations by coordinate descent over holdFrames 2/3/4, tracker minClarity 0.55/0.6/0.65/0.7/0.75/0.8, minAgree 2/3, maxDropout 1/2/3, glide cents 25/30/35/40/45/50, pitch minClarity 0.5/0.55/0.6/0.65/0.7, maximizing calibration note F1 with median latency <= 140 ms and synthetic melody F1 >= 0.91. Stage 2: full grid of 625 key tunings (replayed; 1 confirmed with full runs, which must keep calibration note F1 within 0.005 of the tracker's) over earlyConfidence 0.6/0.65/0.7/0.75/0.8, coverMin 0.8/0.825/0.85/0.875/0.9, coverMargin 0.04/0.06/0.08/0.1/0.12, coverMinSustainSec 1/1.5/2/2.5/3, maximizing calibration key locks with correct, plausible and synthetic-key counts not below the default; run on the stage-1 tracker and, separately, on today's tracker ("keys only").

| tuning | set | note F1 | P | R | latency ms | key locked | plausible | correct | lock median s | synth melody F1 | synth false notes | synth keys ok |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| default | calibration (16) | 0.73 | 0.64 | 0.88 | 110 | 13/16 | 2 | 1 | 2.8 | 0.93 | 23 | 3/4 |
| default | held-out (8) | 0.69 | 0.66 | 0.76 | 102 | 6/8 | 2 | 0 | 3.6 | 0.93 | 23 | 3/4 |
| best (tracker + keys) | calibration (16) | 0.77 | 0.74 | 0.82 | 138 | 15/16 | 2 | 1 | 2.8 | 0.91 | 19 | 3/4 |
| best (tracker + keys) | held-out (8) | 0.77 | 0.78 | 0.77 | 132 | 8/8 | 1 | 0 | 2.9 | 0.91 | 19 | 3/4 |
| tracker only | calibration (16) | 0.77 | 0.74 | 0.82 | 138 | 13/16 | 2 | 1 | 2.9 | 0.91 | 19 | 3/4 |
| tracker only | held-out (8) | 0.77 | 0.78 | 0.77 | 132 | 6/8 | 1 | 0 | 4.3 | 0.91 | 19 | 3/4 |
| keys only | calibration (16) | 0.73 | 0.64 | 0.88 | 110 | 14/16 | 2 | 1 | 2.2 | 0.93 | 23 | 3/4 |
| keys only | held-out (8) | 0.69 | 0.66 | 0.76 | 102 | 8/8 | 2 | 0 | 2.8 | 0.93 | 23 | 3/4 |

| constant | default | best (tracker + keys) | keys only |
|---|---|---|---|
| holdFrames | 3 | 3 | 3 |
| trackerClarity | 0.7 | 0.8 * | 0.7 |
| minAgree | 2 | 3 * | 2 |
| maxDropout | 2 | 1 * | 2 |
| glideCents | 35 | 35 | 35 |
| pitchClarity | 0.6 | 0.6 | 0.6 |
| key.earlyConfidence | 0.7 | 0.6 * | 0.6 * |
| key.coverMin | 0.85 | 0.8 * | 0.8 * |
| key.coverMargin | 0.08 | 0.04 * | 0.04 * |
| key.coverMinSustainSec | 2 | 1 * | 1 * |

Per held-out clip, default -> keys only (note F1, key):

- heycat_2_01: F1 0.57 -> 0.57, key none -> F min @4.0s (label C maj)
- heycat_4_01: F1 0.81 -> 0.81, key D# maj @2.6s plausible -> D# maj @2.6s plausible (label G min)
- yifen_1_01: F1 0.73 -> 0.73, key D# maj @4.2s plausible -> D# maj @4.2s plausible (label C min)
- yifen_3_02: F1 0.71 -> 0.71, key C# min @2.6s -> C# min @2.6s (label D min)
- jmzen_1_01: F1 0.63 -> 0.63, key G min @3.0s -> G min @2.0s (label F min)
- jmzen_3_02: F1 0.87 -> 0.87, key none -> C# min @3.0s (label A min)
- Kenshin_1_01: F1 0.62 -> 0.62, key B min @5.4s -> B min @2.2s (label E min)
- Kenshin_5_03: F1 0.62 -> 0.62, key A# maj @9.3s -> A# maj @7.2s (label F maj)

Candidates against the held-out set:

- best (tracker + keys): reject. Held-out gains (note F1 +0.08, key locks +2) but regressions: plausible 2.00 -> 1.00; synthetic melody F1 0.93 -> 0.91; latency 102 -> 132 ms.
- tracker only: reject. Held-out gains (note F1 +0.08) but regressions: plausible 2.00 -> 1.00; synthetic melody F1 0.93 -> 0.91; latency 102 -> 132 ms.
- keys only: ADOPT. Held-out gains: key locks +2; nothing regressed.

Verdict: adopt "keys only".

Correct = the detected key is the major/minor scale that covers the most of the labelled pitch classes; plausible = that scale covers at least 85% of them. The defaults adopt only when the held-out set gains at least 0.02 note F1 or two key locks and nothing regresses there (F1, P, R, locks, plausible, correct, synthetic melody F1 and key count not lower; latency and false notes not higher).

## Stage 3: onset detector (bench/voice synthetic melodies)

33 evaluations by coordinate descent over quantile 0.6/0.65/0.7/0.75/0.8/0.85, mult 2/2.25/2.5/2.75/3, delta 0.06/0.09/0.12/0.15/0.18, maximizing mean onset precision/recall F1 (100 ms tolerance) against the note starts of the synthetic melody clips, keeping TempoLock's lock count and median lock time on them from getting worse.

| onset tuning | mult | delta | quantile | onset F1 | tempo locked | lock median s |
|---|---|---|---|---|---|---|
| default | 2.5 | 0.12 | 0.75 | 0.78 | 3/3 | 7.6 |
| best | 2.25 | 0.15 | 0.8 | 0.84 | 3/3 | 7.6 |

Verdict: adopt the best onset tuning as default (onset F1 +0.06, tempo lock not worse).

## Stage 4: chord tuning (melody harmonizer)

29 evaluations by coordinate descent over melodyMinCoverage 0.4/0.5/0.6/0.7, melodySwitchMargin 0.05/0.1/0.15/0.2/0.25, melodyWindowMul 1/1.25/1.5/1.75/2, scored by chord-in-force accuracy at bar starts on the arpeggio clip's known progression (bench/voice/output.ts style) and mean keys dissonance on the four real-voice songs (bench/realvoice/fit.ts's `dissonantKeys`); neither may regress.

| chord tuning | melodyMinCoverage | melodySwitchMargin | melodyWindowMul | arpeggio chord accuracy | mean keys dissonance |
|---|---|---|---|---|---|
| default | 0.5 | 0.15 | 1.5 | 0.00 | 0.47 |
| best | 0.4 | 0.15 | 1 | 0.00 | 0.44 |

Per-song keys dissonance, default -> best: amy_15 0.48 -> 0.48, yifen_1 0.35 -> 0.32, abjones_2 0.47 -> 0.38, leon_8 0.59 -> 0.59.

Verdict: adopt the best chord tuning as default (score +0.03, neither metric regressed).

## Stage 5: singer tuning-offset experiment (key detector, report only)

Estimates each clip's global intonation offset from the first 3 s of voiced labels (median cents from the nearest semitone), then replays the labels into a fresh KeyDetector twice per clip -- once rounding as today, once after subtracting that offset -- to isolate what the correction alone would change. Not wired into the app: doing so needs pitchTracker.ts/keyDetector.ts changes, out of scope for this pass.

| | locked | plausible | correct |
|---|---|---|---|
| today (offset 0) | 21/24 | 3 | 1 |
| offset-corrected | 22/24 | 4 | 2 |

Median |offset|: 11 cents. Per-clip: amy_4_01 -16c, amy_15_03 7c, Ani_1_01 16c, Ani_4_02 1c, ariel_1_01 -6c, ariel_3_02 -19c, titon_1_01 -9c, titon_4_03 4c, abjones_1_01 -8c, abjones_3_02 12c, davidson_1_01 -18c, davidson_3_02 4c, geniusturtle_4_01 10c, geniusturtle_7_02 7c, leon_1_01 1c, leon_5_02 13c, heycat_2_01 31c, heycat_4_01 14c, yifen_1_01 -19c, yifen_3_02 19c, jmzen_1_01 -8c, jmzen_3_02 1c, Kenshin_1_01 21c, Kenshin_5_03 -16c.

Verdict: the correction gains plausible keys without losing correct ones -- worth wiring in, but that needs pitchTracker.ts/keyDetector.ts changes out of this pass's scope, so it is reported, not applied.
