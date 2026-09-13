# Would a learned pitch model in the browser beat McLeod + PitchTracker on real amateur singers?

Research spike, 2026-09-13. Same 24 MIR-1K clips, frame metrics and note matching as
bench/realvoice (RESULTS.md there: McLeod 92.4% frame accuracy, note F1 0.68, 119 ms).
Per-clip tables in RESULTS.md here; reproduce with `npx vite-node bench/pitchmodels/run.ts`
after `npm install` inside bench/pitchmodels (onnxruntime-node, dev only, nothing added to the
app) and fetching the model:
`curl -L -o bench/pitchmodels/models/nmp.onnx https://raw.githubusercontent.com/spotify/basic-pitch/main/basic_pitch/saved_models/icassp_2022/nmp.onnx`.

Candidates: pYIN written here in pure TS (pyin.ts, ~150 lines: YIN CMNDF, 100 beta-prior
thresholds, Viterbi over 5-bins-per-semitone pitch states with voiced/unvoiced twins) and
Spotify Basic Pitch (the 230 KB ICASSP-2022 ONNX export, note + onset posteriorgrams and a
3-bins-per-semitone contour, its own note segmentation reimplemented from
`output_to_notes_polyphonic` with library defaults). CREPE tiny was not run: no maintained
ONNX/TF.js export, and Basic Pitch is the one with note segmentation, which is the half we are
actually weak on. Compute is single-threaded Node 20 on a Ryzen 5 PRO 7540U; the 50 ms frame
is our pitch poll, window 4096 samples at 48 kHz.

| method | frame acc % | octave err % | no pitch % | note F1 (P / R) | note latency ms | compute per 50 ms frame | model size | browser feasibility |
|---|---|---|---|---|---|---|---|---|
| McLeod + PitchTracker (ours, shipping) | 92.4 | 0.1 | 1.2 | 0.68 (0.68 / 0.70) | 117 | 3.9 ms | 0 | shipping |
| pYIN, full-clip Viterbi, our tracker | 93.5 | 0.0 | 2.3 | 0.69 (0.67 / 0.73) | 121 | 2.9 ms (2.9 frame + ~0.03 Viterbi) | 0 (pure TS) | yes, but the Viterbi as run sees the whole clip; online needs a fixed-lag decode (adds lag) |
| pYIN, no Viterbi (best candidate per frame, zero lookahead), our tracker | 82.9 | 0.1 | 15.2 | 0.70 (0.74 / 0.69) | 140 | 2.9 ms | 0 | yes, drop-in for detectPitch |
| Basic Pitch contour, raw, frame metric only | 85.2 | 0.2 | 2.9 | — | — | 26 ms per 2 s window | 230 KB + ~10 MB ORT wasm | offline by design: 2 s fixed input window |
| Basic Pitch own note segmentation (offline) | — | — | — | 0.70 (0.61 / 0.86) | n/a (offline, starts known in hindsight) | 26 ms per 2 s window | 230 KB + ORT | not real-time: needs the 2 s window plus an 11-frame (128 ms) lookahead per note |
| Basic Pitch contour through our tracker | 85.2 | 0.2 | 2.9 | 0.58 (0.54 / 0.65) | 105 | 26 ms + tracker | 230 KB + ORT | as above |
| Basic Pitch contour, calibrated -33 cents, our tracker | 90.0 | 0.2 | 2.9 | 0.67 (0.63 / 0.74) | 111 | 26 ms + tracker | 230 KB + ORT | as above |

Notes on the numbers.

- Frame accuracy is saturated for this data. pYIN with a whole-clip Viterbi gains 1.1 points
  over McLeod and removes the last octave errors, and that is with perfect hindsight; the
  remaining 6-8% are slides and scoops between notes (see realvoice/RESULTS.md), which no
  frame estimator can score as "right" against a label that is also mid-slide. Without the
  Viterbi, pYIN's per-frame best candidate is worse than McLeod (82.9%), mostly because its
  voicing decision throws away 15% of voiced frames; its candidates are no better than
  McLeod's peak picking, the smoothing is the whole gain.
- Note F1 does not move. Every pitch source fed into our PitchTracker lands at 0.67-0.70, and
  Basic Pitch's own learned onset/note segmentation also lands at 0.70, by trading precision
  for recall (0.61 / 0.86: it splits long notes at every vibrato swell, and the library
  defaults are tuned for polyphonic transcription). The F1 ceiling is the labels: a hand
  label 40-60 cents off a semitone rounds one way and the detector the other, and the bench
  counts that as a miss. This is the same conclusion realvoice/RESULTS.md reached from the
  other side.
- Basic Pitch reads ~35 cents sharp against the MIR-1K labels on every clip (the error
  histogram peaks at +20..+50 cents, never near 0; diag.ts). The bin grid and the frame
  timing were checked against upstream constants.py / note_creation.py; the bias is in the
  model on this material (22 kHz input, amateur solo voice, which it was not primarily
  trained on). Shifting one contour bin down recovers 90.0%, still under McLeod.
- Cost. pYIN's frame analysis is cheaper than our McLeod (2.9 vs 3.9 ms, both O(n*maxLag) over
  the 4096 window; pYIN uses a fixed integration window so it does less work per lag) and
  the Viterbi is negligible. Basic Pitch is 26 ms per 2 s window single-threaded in native
  ORT; browser WASM is typically 3-5x slower, so 80-130 ms per inference. Run hopped (once
  per 1.64 s) it amortises to ~1 ms per 50 ms frame but the band hears notes 2 s late; run
  sliding every 50 ms it does not fit the frame at all. The 230 KB model is not the cost,
  the ~10 MB onnxruntime-web runtime and a second WASM thread are.

## Recommendation

Keep McLeod + PitchTracker. On real amateur singers the frame estimator is not where the
error is: the best offline pYIN beats it by one point and Basic Pitch loses to it, and all
three give the same note F1 through the same tracker, so the 0.68 is the labels' intonation
and our segmentation rules, not the pitch source. Switching to pYIN would be a real option
only if we want the octave-error and voicing robustness for free in pure TS (it is cheaper
per frame), but an online fixed-lag Viterbi would have to be written and tuned to keep the
gain, and the gain is ~1% of frames; not worth touching a shipping detector for. Going
learned is a clear no for this product: Basic Pitch is built around a 2 s window and a
128 ms note lookahead, its frame pitch is worse than McLeod on this data, and it costs a
10 MB runtime plus 80-130 ms of WASM compute per inference for no F1. If anything is worth
more work, it is the tracker's rounding of 40-60-cent-off notes (a key-aware or
hysteresis-based semitone decision), which is where every method on this table loses its
points.

## Addendum, 2026-09-13: pitchy

The shipping McLeod was replaced by the pitchy library (same McLeod pitch method, FFT-based
NSDF, MIT). Same 9 gate-subset clips, same tracker (`bench/pitchmodels/pitchy.ts`):

| method | pitch acc % | octave err % | no pitch % | note F1 | ms/frame |
|---|---|---|---|---|---|
| our McLeod, O(n·lag) NSDF | 92.9 | 0.1 | 0.8 | 0.72 | 3.94 |
| pitchy, K = 0.8 | 93.1 | 0.2 | 0.9 | 0.73 | 0.21 |
| pitchy, K = 0.9 (its default) | 92.0 | 0.5 | 1.8 | 0.73 | 0.21 |

Equal accuracy at K = 0.8, the same first-peak fraction our code used, at a nineteenth of the
per-frame cost. K = 0.9 loses a point and doubles the octave errors, as the original comment in
pitch.ts predicted. The 60-1200 Hz range and the clarity gate stay in our wrapper.

Follow-up, same day: pitchy's own `findPitch` weighs peaks over every lag, and on the abjones_2
song a tall sub-harmonic peak below 60 Hz made it skip the real fundamental on a couple of
frames; the pitch metrics barely moved but two half bars of the keys comp flipped to dissonant
and the real-voice gate failed by 0.9 points. pitch.ts now uses pitchy's FFT `Autocorrelator`
for the expensive part and keeps our NSDF and 60-1200 Hz peak rule on top. On the same clips it
is now metric-for-metric identical to the old detector (`pitchy_src` == `mcleod_old` in
`bench/pitchmodels/pitchy.ts`) at 0.30 ms per frame; all 44 gate checks pass.
