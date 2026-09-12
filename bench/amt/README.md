# Anticipatory Music Transformer — live-scheduling PoC

Prepared on an M-series Mac (MPS), 2026-09-11/12. Tests the reframe in
`proposal.md`: inference latency (100 ms-1 s+) isn't a latency problem, it's
a *scheduling* problem, solved by writing accompaniment a few beats ahead of
the live playhead and hiding think-time behind that buffer (the ReaLJam
protocol this repo's Lyria/ACE engines already use in spirit: lookahead,
commit, listen-first). This is a from-scratch Python prototype, independent
of `src/engines/` — it exists to answer "is this model viable as a fourth
`BandEngine`," not to be one yet.

Model: `stanford-crfm/music-small-800k` (128M params, Apache 2.0) via
Stanford CRFM's [`anticipation`](https://github.com/jthickstun/anticipation)
package. Not on PyPI — install from GitHub (see below).

## What it does

- `melody.py` — a synthetic scale-constrained melody (built with `musicpy`),
  standing in for a live player.
- `amt.py` — the model interface: event↔token encoding, and a logit mask
  that restricts generation to melody (piano) plus a configurable set of
  companion instruments, instead of letting a Lakh-trained checkpoint
  free-associate across all 128. Solo mode is one violin; `--ensemble` adds
  a steel guitar as a second, independent voice. Both were chosen
  empirically — they're the instruments this checkpoint actually writes
  substantial output for against a solo piano prompt; see "Findings" below
  for the selection sweep.
- `live_duet.py` — the scheduler. Runs a real wall-clock transport; the
  melody is only ever revealed up to the current playhead (no peeking at its
  own future), and a background thread continuously asks the model to write
  `--lookahead-beats` of accompaniment past the last committed point, of
  which only `--commit-beats` is frozen. The rest is discarded and
  regenerated once more real melody has arrived. If the model doesn't
  finish before its own deadline, that's logged as a genuine underrun, not
  hidden. If a window comes back with zero companion notes at all (a
  legitimate sample, just an unwanted one), it's retried up to
  `MAX_GENERATION_ATTEMPTS` times before being accepted as silence. By
  default each companion instrument is kept independently monophonic (no
  self-overlap, "one violin") by trimming a note's tail if that same
  instrument's next note starts before it ends — the model has no such
  constraint on its own; `--multi-voice` disables this per instrument
  ("multiple violins", a section instead of a soloist). Different
  instruments in an ensemble may always sound together regardless. Output
  is a MIDI file of exactly what was decided live.

## Run

```bash
pip install torch transformers musicpy
pip install git+https://github.com/jthickstun/anticipation.git
python live_duet.py --notes 32 --bpm 80 --lookahead-beats 2.5 --commit-beats 1.75
python live_duet.py --notes 32 --bpm 80 --lookahead-beats 2.5 --commit-beats 1.75 --ensemble --multi-voice
# writes ../../output/live_duet.mid relative to this dir by default; override with --outdir
```

Flags: `--bpm`, `--key`/`--mode`, `--notes` (melody length), `--seed`,
`--lookahead-beats`, `--commit-beats`, `--listen-first-beats`, `--top-p`,
`--accomp-bias` (logit bias toward the kept instrument(s) — free, since the
alternative is always discarded anyway). Two independent, composable
toggles: `--ensemble` picks *which* instrument(s) play (violin alone, or
violin + steel guitar) and `--multi-voice` picks *how many notes at once* a
given instrument may play (one at a time, "one violin", the default; or
overlapping, "multiple violins", a section). All four combinations work.

## Findings

- **The output used to run much longer than the input melody -- fixed.**
  `_maybe_kick_generation` had no upper bound on `committed_horizon`, so once
  the melody ended it kept pipelining new lookahead windows every cycle
  regardless -- there was no more melody to inform them, but nothing said
  "stop". Since the outer loop's only exit condition was wall-clock time
  reaching `melody_len_s + tail_s`, and the model usually runs faster than
  real time, `committed_horizon` (music time already planned) could race far
  ahead of the wall clock before the loop noticed it should stop: one 19.1s
  melody produced a 33.5s MIDI file. Capping `_maybe_kick_generation` at
  `committed_horizon >= melody_len_s + tail_s` fixed it (same melody now
  produces 21.85s) and also finishes faster (9.4s wall time vs. 17.4s,
  fewer wasted inference calls: 13 vs. 21) since it stops working the moment
  there's nothing left to usefully generate for.
- **Realtime factor 1.3x-3.6x** across runs on an M-series Mac/MPS, for
  ~1.5-2.5 beat commit windows at 80 BPM — net faster than real time on
  average, but with **high per-call variance** (0.1 s-9 s for similarly
  sized chunks). A standing buffer (priming the first chunk a full
  lookahead early, plus continuous pipelining once the loop is running)
  absorbs most of that variance; a few underruns still happen on a loaded
  machine. This is the actual go/no-go number `proposal.md` asks for from
  the first two hours of work — worth re-measuring on real target hardware
  before committing to this model for a live demo.
- **The base checkpoint needs help to act like a duet, not a Lakh song.**
  Given only a sparse prompt, unmasked generation sprayed notes across a
  dozen-plus unrelated GM instruments — Lakh MIDI is full of multi-track
  songs, so that's an in-distribution sample, just not a useful one here.
  Masking down to a small instrument set fixes the spraying, but the model
  still sometimes chooses to write *zero* companion notes in a window (also
  a legitimate sample) — several in a row leaves the companion audibly
  silent (one run had a 9.6s gap out of a 24.7s piece).
- **A logit bias toward the kept instrument(s) helps but isn't reliable
  enough on its own.** Sweeping `--accomp-bias` from 2 to 10 across several
  melodies raised *average* note density, but individual runs still landed
  double-digit-second silent stretches regardless, and the relationship
  wasn't even monotonic (bias 8 was sometimes worse than bias 6). What
  actually closes the gap: when a window comes back with literally nothing,
  just ask again. Retrying up to `MAX_GENERATION_ATTEMPTS` (2, tuned
  empirically) cut the longest observed silent gap from 9.6s to ~6-7s across
  test seeds, at essentially no quality cost since resampling doesn't touch
  the musical decision, only whether an empty answer gets accepted. The
  tradeoff is real, though: each retry multiplies that window's generation
  time, and pushing the retry count to 4 was enough to wreck the realtime
  factor on one melody (16 of 17 windows underran, factor 1.37x vs. 2-3x
  typical at 2 attempts) — silence-avoidance and real-time viability trade
  directly against each other on this hardware, they don't come for free
  together.
- **Instrument pairing is not arbitrary.** A sweep over candidate GM
  accompaniment instruments against the same piano prompt found wildly
  different note yields (e.g. violin ≈40+ notes per window vs. bass ≈0) —
  worth re-sweeping per melody instrument if this becomes a real engine.
  `--ensemble` (violin + steel guitar) uses the two instruments actually
  confirmed by that sweep; an idiomatically nicer string-section pairing
  (e.g. viola/cello) was not swept and may turn out silent.
- **Monophony is a choice, not a constraint of the model.** `--multi-voice`
  simply skips the trim/dedup step at commit time — same generated notes,
  just not forced into a single line. Verified on one run: 34 violin notes
  / 0 self-overlaps with the default, vs. 43 violin notes / 32 self-overlaps
  with `--multi-voice` on the same melody/seed. Composes cleanly with
  `--ensemble` too (each instrument's polyphony is independent).
- **It doesn't just double the melody.** Checked one run's committed notes:
  41 accompaniment vs. 32 melody notes, only 1/41 at the exact same pitch,
  4/41 sharing a pitch class (unison/octave), and a pitch range (48-90)
  extending both above and below the melody's (60-72). No explicit
  diversity constraint is applied — this fell out of the instrument split
  and the base model's learned behavior on real multi-track songs, not
  something enforced. `proposal.md`'s best-of-k reranking would be the
  principled way to *guarantee* this rather than rely on it.
- **This PoC has no input latency** (`proposal.md`'s delay #1) because the
  "performer" is synthetic Python events, not a transcribed instrument —
  it only exercises delay #2 (inference/scheduling), which was the point.
  Wiring this to Backline's actual `Listener` would need each incoming
  note-on/off converted to the same `(onset_s, dur_s, pitch)` shape
  `melody.py` produces; MIDI input needs no transcription step at all,
  audio input (this repo's mic path) would need real pitch tracking first,
  with its own latency and error modes on top of everything measured here.

## Next steps if this becomes a real `BandEngine`

- Re-measure realtime factor on whatever hardware would actually run it
  (this was CPU/MPS on a laptop, not a GPU pod like ACE's).
- Best-of-k reranking (per `proposal.md`) instead of the flat accompaniment
  bias, for an actual quality/distinctiveness signal rather than a fixed
  nudge.
- Real MIDI input via `src/listener/`, feeding `LiveDuet._reveal_melody`'s
  role instead of a precomposed array.
