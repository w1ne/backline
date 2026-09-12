# Listener calibration (MIR-1K)

Generated 2026-09-12 by bench/calibrate/run.ts in 232s. Calibration: 16 clips (amy, Ani, ariel, titon, abjones, davidson, geniusturtle, leon). Held out: 8 clips (heycat, yifen, jmzen, Kenshin). Stage 1: 55 tracker evaluations by coordinate descent over holdFrames 2/3/4, tracker minClarity 0.55/0.6/0.65/0.7/0.75/0.8, minAgree 2/3, maxDropout 1/2/3, glide cents 25/30/35/40/45/50, pitch minClarity 0.5/0.55/0.6/0.65/0.7, maximizing calibration note F1 with median latency <= 140 ms and synthetic melody F1 >= 0.89. Stage 2: full grid of 625 key tunings (replayed; 418 confirmed with full runs, which must keep calibration note F1 within 0.005 of the tracker's) over earlyConfidence 0.6/0.65/0.7/0.75/0.8, coverMin 0.8/0.825/0.85/0.875/0.9, coverMargin 0.04/0.06/0.08/0.1/0.12, coverMinSustainSec 1/1.5/2/2.5/3, maximizing calibration key locks with correct, plausible and synthetic-key counts not below the default; run on the stage-1 tracker and, separately, on today's tracker ("keys only").

| tuning | set | note F1 | P | R | latency ms | key locked | plausible | correct | lock median s | synth melody F1 | synth false notes | synth keys ok |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| default | calibration (16) | 0.69 | 0.67 | 0.73 | 120 | 14/16 | 2 | 1 | 3.7 | 0.91 | 18 | 4/4 |
| default | held-out (8) | 0.66 | 0.70 | 0.63 | 119 | 5/8 | 2 | 0 | 4.1 | 0.91 | 18 | 4/4 |
| best (tracker + keys) | calibration (16) | 0.70 | 0.69 | 0.74 | 124 | 12/16 | 2 | 1 | 3.8 | 0.91 | 17 | 3/4 |
| best (tracker + keys) | held-out (8) | 0.68 | 0.73 | 0.65 | 130 | 6/8 | 2 | 1 | 4.1 | 0.91 | 17 | 3/4 |
| tracker only | calibration (16) | 0.70 | 0.69 | 0.74 | 124 | 12/16 | 2 | 1 | 3.8 | 0.91 | 17 | 3/4 |
| tracker only | held-out (8) | 0.68 | 0.73 | 0.65 | 130 | 6/8 | 2 | 1 | 4.1 | 0.91 | 17 | 3/4 |
| keys only | calibration (16) | 0.68 | 0.66 | 0.73 | 121 | 16/16 | 2 | 1 | 2.4 | 0.90 | 17 | 4/4 |
| keys only | held-out (8) | 0.64 | 0.65 | 0.63 | 125 | 8/8 | 2 | 0 | 3.0 | 0.90 | 17 | 4/4 |

| constant | default | best (tracker + keys) | keys only |
|---|---|---|---|
| holdFrames | 3 | 3 | 3 |
| trackerClarity | 0.7 | 0.8 * | 0.7 |
| minAgree | 2 | 2 | 2 |
| maxDropout | 2 | 2 | 2 |
| glideCents | 35 | 25 * | 35 |
| pitchClarity | 0.6 | 0.7 * | 0.6 |
| key.earlyConfidence | 0.7 | 0.7 | 0.6 * |
| key.coverMin | 0.85 | 0.85 | 0.825 * |
| key.coverMargin | 0.08 | 0.08 | 0.04 * |
| key.coverMinSustainSec | 2 | 2 | 1 * |

Per held-out clip, default -> best (tracker + keys) (note F1, key):

- heycat_2_01: F1 0.54 -> 0.65, key none -> none (label C maj)
- heycat_4_01: F1 0.80 -> 0.83, key D# maj @3.5s plausible -> D# maj @2.9s plausible (label G min)
- yifen_1_01: F1 0.60 -> 0.60, key D# maj @4.1s plausible -> D# maj @4.1s plausible (label C min)
- yifen_3_02: F1 0.67 -> 0.67, key none -> none (label D min)
- jmzen_1_01: F1 0.60 -> 0.58, key G min @3.0s -> G min @3.0s (label F min)
- jmzen_3_02: F1 0.83 -> 0.78, key none -> A min @6.5s correct (label A min)
- Kenshin_1_01: F1 0.61 -> 0.72, key B maj @4.9s -> B min @4.2s (label E min)
- Kenshin_5_03: F1 0.62 -> 0.62, key A# maj @9.3s -> A# maj @9.3s (label F maj)

Candidates against the held-out set:

- best (tracker + keys): reject. Held-out gains (note F1 +0.02) but regressions: synthetic keys 4.00 -> 3.00; latency 119 -> 130 ms.
- tracker only: reject. Held-out gains (note F1 +0.02) but regressions: synthetic keys 4.00 -> 3.00; latency 119 -> 130 ms.
- keys only: reject. Held-out gains (key locks +3) but regressions: note F1 0.66 -> 0.64; P 0.70 -> 0.65; synthetic melody F1 0.91 -> 0.90; latency 119 -> 125 ms.

Verdict: keep the defaults.

Correct = the detected key is the major/minor scale that covers the most of the labelled pitch classes; plausible = that scale covers at least 85% of them. The defaults adopt only when the held-out set gains at least 0.02 note F1 or two key locks and nothing regresses there (F1, P, R, locks, plausible, correct, synthetic melody F1 and key count not lower; latency and false notes not higher).
