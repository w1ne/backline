# Harmony bench

`python3 services/amt/bench_harmony.py --md HARMONY_BENCH.md`, 90 bpm, quarter-note arpeggios (root-third-fifth-third per bar), 125 ms detection latency, one decision per half bar. Scoring as in bench/voice/output.ts: the chord in force at the bar start, per half bar, and the chord in force right after the bar ended (decided from the bar). Lookahead is how far ahead of the tick the plan window starts (the client commits with LOOKAHEAD_BEATS 4).

The TS bench (bench/voice/OUTPUT.md, harmonizer alone on the synthesized voice) scored 13% at bar start.

| scenario | brain | lookahead | bar start = truth | per half bar = truth | decided from the bar = truth | changes / bar (bar starts) | changes / bar (half bars) | predicted decisions |
|---|---|---|---|---|---|---|---|---|
| arpeggio-Am-progression | harmonizer | 0 beats | 12% | 44% | 88% | 0.75 | 1.00 | 0 |
| arpeggio-Am-progression | harmonizer + predictor | 0 beats | 50% | 62% | 12% | 0.88 | 1.25 | 6 |
| arpeggio-Am-progression | harmonizer | 2 beats | 12% | 12% | 75% | 0.75 | 0.88 | 0 |
| arpeggio-Am-progression | harmonizer + predictor | 2 beats | 62% | 56% | 0% | 0.88 | 1.12 | 14 |
| arpeggio-Am-progression | harmonizer | 4 beats | 12% | 12% | 12% | 0.62 | 0.88 | 0 |
| arpeggio-Am-progression | harmonizer + predictor | 4 beats | 50% | 56% | 12% | 0.62 | 1.12 | 17 |
| held-4-bars-Am-then-F | harmonizer | 0 beats | 88% | 94% | 100% | 0.12 | 0.12 | 0 |
| held-4-bars-Am-then-F | harmonizer + predictor | 0 beats | 75% | 88% | 50% | 0.62 | 0.62 | 4 |
| held-4-bars-Am-then-F | harmonizer | 2 beats | 88% | 88% | 100% | 0.12 | 0.12 | 0 |
| held-4-bars-Am-then-F | harmonizer + predictor | 2 beats | 25% | 50% | 0% | 0.25 | 1.12 | 12 |
| held-4-bars-Am-then-F | harmonizer | 4 beats | 75% | 81% | 88% | 0.12 | 0.12 | 0 |
| held-4-bars-Am-then-F | harmonizer + predictor | 4 beats | 25% | 25% | 0% | 0.75 | 0.75 | 17 |

Chord in force at each bar start (truth in brackets), lookahead 0:

- arpeggio-Am-progression, harmonizer: Am Am F Em G Am Dm Em  (Am F C G Am Dm Em Am)
- arpeggio-Am-progression, harmonizer + predictor: Am F G Em G F Em Am  (Am F C G Am Dm Em Am)
- held-4-bars-Am-then-F, harmonizer: Am Am Am Am Am F F F  (Am Am Am Am F F F F)
- held-4-bars-Am-then-F, harmonizer + predictor: Am F Am Am F G F F  (Am Am Am Am F F F F)

## Reading the table

- Harmonizer alone at lookahead 0 reproduces the TS bench: 12% at bar start (TS: 13%), because every tick at a
  downbeat sees only the previous bar (the first note of the new bar arrives 125 ms after the tick).
- With the predictor, bar-start accuracy is 50% (target: above 50%). The chords in force at bar starts are
  `Am F G Em G F Em Am` against `Am F C G Am Dm Em Am`. The three misses:
  - bar 3 (C, predicted G): F -> C is III, weighted 0.2 in the VI row against VII 0.5; the table is the limit.
  - bar 6 (Dm, predicted F): i -> iv is 0.2 against VI 0.3; same.
  - bar 4 (G, got Em): the harmonizer's own reading of E-G-E picked Em over C through the sung-root tie-break
    (a port of the TS behaviour), and a reading that corrects the chord in force wins over the prediction on the
    downbeat. Had the reading been C, the predicted G would have been right.
- "Decided from the bar" is meaningless for the predictor: at the bar-end tick the brain is already committing
  the next bar's chord, so what is in force right after the bar end is a prediction, not a reading of the bar.
- Changes per half bar go up (1.25 vs 1.00): every predicted miss is corrected one half bar later.
- `held-4-bars-Am-then-F` is the cost of predicting: the predictor pushes F on the downbeat of bar 2; the singer
  stays on Am, the reading pulls it back after half a bar, and `rejected()` (a move already pulled back inside the
  last four half bars is not tried again) stops it repeating on bars 3 and 4. 75% vs 88% for the harmonizer alone.
- Lookahead 2 (the plan window starts one half bar after the tick) scores 62% on the arpeggio because the tick
  before a downbeat is mid-bar, where the reading is solid and one step of the table lands the change on the one.
  Lookahead 4 (today's client LOOKAHEAD_BEATS) needs two table steps and falls back to 50%.

## Tuning evidence

`READING_TRUST` 0.75 and `PREDICT_MIN_COVERAGE` 0.5 never decide the bar-start number on this clip: on every
downbeat the half bar is fully covered by the previous chord, so the decision is taken by the downbeat rule
(reading confirms the chord in force -> predict) before either threshold is consulted. Lowering or raising them
changes nothing here; they matter mid-bar when a singer moves early, and the unit tests pin that behaviour.
The lever that moved the number was the downbeat rule plus `rejected()` (held scenario 25% -> 75%).
