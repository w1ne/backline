# Harmony bench

`python3 services/amt/bench_harmony.py --md HARMONY_BENCH.md`, 90 bpm, quarter-note arpeggios (root-third-fifth-third per bar), 125 ms detection latency, one decision per half bar. Scoring as in bench/voice/output.ts: the chord in force at the bar start, per half bar, and the chord in force right after the bar ended (decided from the bar). Lookahead is how far ahead of the tick the plan window starts (the client commits with LOOKAHEAD_BEATS 2, src/engines/amtEngine.ts).

The TS bench (bench/voice/OUTPUT.md, harmonizer alone on the synthesized voice) scored 13% at bar start.

| scenario | brain | lookahead | bar start = truth | per half bar = truth | decided from the bar = truth | changes / bar (bar starts) | changes / bar (half bars) | predicted decisions |
|---|---|---|---|---|---|---|---|---|
| arpeggio-Am-progression | harmonizer | 0 beats | 12% | 44% | 88% | 0.75 | 1.00 | 0 |
| arpeggio-Am-progression | harmonizer + table | 0 beats | 50% | 62% | 12% | 0.88 | 1.25 | 6 |
| arpeggio-Am-progression | harmonizer + hmm | 0 beats | 75% | 81% | 0% | 0.88 | 1.00 | 8 |
| arpeggio-Am-progression | harmonizer | 2 beats | 12% | 12% | 75% | 0.75 | 0.88 | 0 |
| arpeggio-Am-progression | harmonizer + table | 2 beats | 62% | 56% | 0% | 0.88 | 1.12 | 14 |
| arpeggio-Am-progression | harmonizer + hmm | 2 beats | 62% | 69% | 0% | 0.88 | 1.12 | 16 |
| arpeggio-Am-progression | harmonizer | 4 beats | 12% | 12% | 12% | 0.62 | 0.88 | 0 |
| arpeggio-Am-progression | harmonizer + table | 4 beats | 50% | 56% | 12% | 0.62 | 1.12 | 17 |
| arpeggio-Am-progression | harmonizer + hmm | 4 beats | 62% | 62% | 12% | 0.88 | 1.00 | 17 |
| held-4-bars-Am-then-F | harmonizer | 0 beats | 88% | 94% | 100% | 0.12 | 0.12 | 0 |
| held-4-bars-Am-then-F | harmonizer + table | 0 beats | 75% | 88% | 50% | 0.62 | 0.62 | 4 |
| held-4-bars-Am-then-F | harmonizer + hmm | 0 beats | 75% | 88% | 50% | 0.62 | 0.62 | 4 |
| held-4-bars-Am-then-F | harmonizer | 2 beats | 88% | 88% | 100% | 0.12 | 0.12 | 0 |
| held-4-bars-Am-then-F | harmonizer + table | 2 beats | 25% | 50% | 0% | 0.25 | 1.12 | 12 |
| held-4-bars-Am-then-F | harmonizer + hmm | 2 beats | 75% | 75% | 50% | 0.62 | 0.62 | 12 |
| held-4-bars-Am-then-F | harmonizer | 4 beats | 75% | 81% | 88% | 0.12 | 0.12 | 0 |
| held-4-bars-Am-then-F | harmonizer + table | 4 beats | 25% | 25% | 0% | 0.75 | 0.75 | 17 |
| held-4-bars-Am-then-F | harmonizer + hmm | 4 beats | 38% | 56% | 50% | 0.75 | 0.88 | 17 |
| pop-loop-C-I-V-vi-IV | harmonizer | 0 beats | 12% | 38% | 88% | 0.75 | 1.12 | 0 |
| pop-loop-C-I-V-vi-IV | harmonizer + table | 0 beats | 38% | 50% | 25% | 0.88 | 1.38 | 5 |
| pop-loop-C-I-V-vi-IV | harmonizer + hmm | 0 beats | 62% | 81% | 0% | 0.88 | 1.25 | 8 |
| pop-loop-C-I-V-vi-IV | harmonizer | 2 beats | 12% | 12% | 62% | 0.75 | 1.00 | 0 |
| pop-loop-C-I-V-vi-IV | harmonizer + table | 2 beats | 62% | 50% | 0% | 0.88 | 1.25 | 13 |
| pop-loop-C-I-V-vi-IV | harmonizer + hmm | 2 beats | 75% | 69% | 0% | 0.88 | 1.00 | 16 |
| pop-loop-C-I-V-vi-IV | harmonizer | 4 beats | 12% | 12% | 12% | 0.62 | 1.00 | 0 |
| pop-loop-C-I-V-vi-IV | harmonizer + table | 4 beats | 25% | 44% | 25% | 0.88 | 1.38 | 17 |
| pop-loop-C-I-V-vi-IV | harmonizer + hmm | 4 beats | 50% | 62% | 0% | 0.62 | 1.00 | 17 |
| minor-loop-Am-i-VII-VI-VII | harmonizer | 0 beats | 12% | 56% | 100% | 0.75 | 0.88 | 0 |
| minor-loop-Am-i-VII-VI-VII | harmonizer + table | 0 beats | 38% | 69% | 25% | 0.75 | 1.38 | 6 |
| minor-loop-Am-i-VII-VI-VII | harmonizer + hmm | 0 beats | 38% | 69% | 25% | 0.62 | 1.38 | 6 |
| minor-loop-Am-i-VII-VI-VII | harmonizer | 2 beats | 12% | 12% | 100% | 0.75 | 0.75 | 0 |
| minor-loop-Am-i-VII-VI-VII | harmonizer + table | 2 beats | 50% | 44% | 0% | 0.88 | 1.00 | 14 |
| minor-loop-Am-i-VII-VI-VII | harmonizer + hmm | 2 beats | 38% | 38% | 25% | 0.62 | 0.62 | 14 |
| minor-loop-Am-i-VII-VI-VII | harmonizer | 4 beats | 50% | 31% | 12% | 0.62 | 0.75 | 0 |
| minor-loop-Am-i-VII-VI-VII | harmonizer + table | 4 beats | 25% | 38% | 62% | 0.75 | 1.38 | 17 |
| minor-loop-Am-i-VII-VI-VII | harmonizer + hmm | 4 beats | 50% | 44% | 0% | 0.75 | 0.88 | 17 |

Bar-start accuracy, table vs hmm, per lookahead (lookahead 2 is the client setting):

| scenario | harmonizer @0 | table @0 | hmm @0 | harmonizer @2 | table @2 | hmm @2 | harmonizer @4 | table @4 | hmm @4 |
|---|---|---|---|---|---|---|---|---|---|
| arpeggio-Am-progression | 12% | 50% | 75% | 12% | 62% | 62% | 12% | 50% | 62% |
| held-4-bars-Am-then-F | 88% | 75% | 75% | 88% | 25% | 75% | 75% | 25% | 38% |
| pop-loop-C-I-V-vi-IV | 12% | 38% | 62% | 12% | 62% | 75% | 12% | 25% | 50% |
| minor-loop-Am-i-VII-VI-VII | 12% | 38% | 38% | 12% | 50% | 38% | 50% | 25% | 50% |
| mean | 31% | 50% | 62% | 31% | 50% | 62% | 38% | 31% | 50% |

Chord in force at each bar start (truth in brackets), lookahead 0:

- arpeggio-Am-progression, harmonizer: Am Am F Em G Am Dm Em  (Am F C G Am Dm Em Am)
- arpeggio-Am-progression, harmonizer + table: Am F G Em G F Em Am  (Am F C G Am Dm Em Am)
- arpeggio-Am-progression, harmonizer + hmm: Am F C G Am F C Am  (Am F C G Am Dm Em Am)
- held-4-bars-Am-then-F, harmonizer: Am Am Am Am Am F F F  (Am Am Am Am F F F F)
- held-4-bars-Am-then-F, harmonizer + table: Am F Am Am F G F F  (Am Am Am Am F F F F)
- held-4-bars-Am-then-F, harmonizer + hmm: Am F Am Am F C F F  (Am Am Am Am F F F F)
- pop-loop-C-I-V-vi-IV, harmonizer: C C G Am F Em G Am  (C G Am F C G Am F)
- pop-loop-C-I-V-vi-IV, harmonizer + table: C F G F G Em G F  (C G Am F C G Am F)
- pop-loop-C-I-V-vi-IV, harmonizer + hmm: C G C F C F C F  (C G Am F C G Am F)
- minor-loop-Am-i-VII-VI-VII, harmonizer: Am Am G F G Am G F  (Am G F G Am G F G)
- minor-loop-Am-i-VII-VI-VII, harmonizer + table: Am F Am G G F Am G  (Am G F G Am G F G)
- minor-loop-Am-i-VII-VI-VII, harmonizer + hmm: Am F F Am G F F Am  (Am G F G Am G F G)

## Reading the table

- Harmonizer alone at lookahead 0 reproduces the TS bench: 12% at bar start on the arpeggio (TS: 13%), because
  every tick at a downbeat sees only the previous bar (the first note of the new bar arrives 125 ms after the tick).
- `table` is the hand-written first-order table (MAJOR_TABLE / MINOR_TABLE in predict.py). Its arpeggio misses:
  F -> C (III weighted 0.2 against VII 0.5), i -> iv (0.2 against VI 0.3), and bar 4 where the harmonizer's own
  E-G-E reading picked Em over C and a reading that corrects the chord in force wins over the prediction.
- `hmm` is `predict_next_hmm`: degree transitions fitted on Chordonomicon (fit_transitions.py: 468k songs after key
  estimation, first- and second-order counts per mode with add-0.5 smoothing, first-order rows per genre for
  jazz/rock/pop shrunk toward the mode row), a Viterbi decode of the last four half-bar coverage vectors (stay
  probability 0.35 across a bar line, 0.85 mid-bar; emission coverage^alpha with a 1.5x root-sung bonus) that
  replaces the harmonizer's lagging reading with the chord the singer is decoded on, then the argmax of the
  second-order row from the decoded (previous, current) pair. On a downbeat it predicts even when the decoded bar
  corrects the chord in force: the coming bar is more likely a step on from the decoded chord than a late copy
  of it. `brain.py` uses it by default (PREDICTOR = 'hmm').
- The arpeggio's remaining hmm misses are corpus preferences, not decode errors: i -> VI (0.34) over i -> iv
  (0.10) at bar 5, and (i, iv) -> i over (i, iv) -> v at bar 6. The minor loop loses the same way: (VI, VII) -> i
  outweighs VII -> VI on every second pass, and i -> VI outweighs i -> VII.
- "Decided from the bar" is meaningless for either predictor: at the bar-end tick the brain is already committing
  the next bar's chord, so what is in force right after the bar end is a prediction, not a reading of the bar.
- `held-4-bars-Am-then-F` is the cost of predicting: a predictor pushes a change on the downbeat of bar 2; the
  singer stays on Am, the reading pulls it back after half a bar, and `rejected()` (a PREDICTED push off the chord
  in force that the singer pulled back inside the last six half bars blocks every move) stops it repeating on
  bars 3 and 4. Both predictors pay one bar for the push and one for the change to F a bar late.
- Lookahead 2 is the client's setting (LOOKAHEAD_BEATS in amtEngine.ts). The tick before a downbeat is mid-bar,
  so the decode has only one half bar of the current chord; the hmm walks from the decoded pair with
  `predict_ahead_hmm` and stops at a rejected push, which is what lifts the held scenario from 25% to 62%.

## Tuning evidence

`READING_TRUST` 0.75 and `PREDICT_MIN_COVERAGE` 0.5 never decide the bar-start number on these clips: on every
downbeat the half bar is fully covered by the previous chord, so the decision is taken by the downbeat rule
before either threshold is consulted. They matter mid-bar when a singer moves early, and the unit tests pin that.

Stay probabilities 0.25/0.75 cost the held scenario (38%); 0.5/0.9 cost the arpeggio (50%). The 1.5x root bonus
is what separates Dm from F and C from Am on two-note half bars; without it the arpeggio is 62% and the pop loop
75% at lookahead 0 but lookahead 2 drops to 53%. Genre rows are used only for the step forward, never inside the
decode: the decode identifies, the genre steps. A soft (posterior-weighted) mid-bar step was tried and dropped:
same mean, and the jazz/lofi rows made it flip close calls.

`EMISSION_ALPHA` sweep (hmm, bar-start accuracy, lookahead 0; `python3 bench_harmony.py --tune`):

| alpha | arpeggio-Am-progression | held-4-bars-Am-then-F | pop-loop-C-I-V-vi-IV | minor-loop-Am-i-VII-VI-VII | mean |
|---|---|---|---|---|---|
| 0.5 | 50% | 75% | 50% | 12% | 47% |
| 0.75 | 50% | 75% | 50% | 12% | 47% |
| 1 | 50% | 75% | 62% | 12% | 50% |
| 1.5 | 50% | 75% | 62% | 38% | 56% |
| 2 | 75% | 75% | 62% | 38% | 62% |
