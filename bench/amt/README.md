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
  that restricts generation to two GM instruments (piano = melody, violin =
  accompaniment) instead of letting a Lakh-trained checkpoint free-associate
  across all 128. Violin was chosen empirically — it's the instrument this
  checkpoint pairs most readily with a solo piano prompt; see "Findings"
  below for the actual selection sweep.
- `live_duet.py` — the scheduler. Runs a real wall-clock transport; the
  melody is only ever revealed up to the current playhead (no peeking at its
  own future), and a background thread continuously asks the model to write
  `--lookahead-beats` of accompaniment past the last committed point, of
  which only `--commit-beats` is frozen. The rest is discarded and
  regenerated once more real melody has arrived. If the model doesn't
  finish before its own deadline, that's logged as a genuine underrun, not
  hidden. Committed accompaniment notes are also kept monophonic (one
  violin, one note at a time) by trimming a note's tail if the next one
  starts before it ends -- the model has no such constraint on its own and
  will happily commit overlapping notes. Output is a MIDI file of exactly
  what was decided live.

## Run

```bash
pip install torch transformers musicpy
pip install git+https://github.com/jthickstun/anticipation.git
python live_duet.py --notes 32 --bpm 80 --lookahead-beats 2.5 --commit-beats 1.75
# writes ../../output/live_duet.mid relative to this dir by default; override with --outdir
```

Flags: `--bpm`, `--key`/`--mode`, `--notes` (melody length), `--seed`,
`--lookahead-beats`, `--commit-beats`, `--listen-first-beats`, `--top-p`,
`--accomp-bias` (logit bias toward the kept instrument — free, since its
alternative is always discarded anyway).

## Findings

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
  Given only a sparse two-instrument prompt, unmasked generation sprayed
  notes across a dozen-plus unrelated GM instruments — Lakh MIDI is full of
  multi-track songs, so that's an in-distribution sample, just not a useful
  one here. Masking down to two instruments fixes the spraying, but the
  model still sometimes chooses to write *zero* accompaniment notes in a
  window (a legitimate sample, just not a wanted one) — a small logit bias
  toward the kept instrument fixes that too, at no coherence cost, since we
  discard every melody-instrument note it writes past the live playhead
  anyway.
- **Instrument pairing is not arbitrary.** A sweep over candidate GM
  accompaniment instruments against the same piano prompt found wildly
  different note yields (e.g. violin ≈40+ notes per window vs. bass ≈0) —
  worth re-sweeping per melody instrument if this becomes a real engine.
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
