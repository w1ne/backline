# Anticipatory Music Transformer — live-scheduling PoC

Prepared on an M-series Mac (MPS), 2026-09-11/12, then merged forward from a
sibling research repo ("Music") on 2026-09-12. Tests the reframe in
`proposal.md`: inference latency (100 ms-1 s+) isn't a latency problem, it's
a *scheduling* problem, solved by writing accompaniment a few beats ahead of
the live playhead and hiding think-time behind that buffer (the ReaLJam
protocol this repo's Lyria/ACE engines already use in spirit: lookahead,
commit, listen-first). This is a from-scratch Python prototype, independent
of `src/engines/` — it exists to answer "is this model viable as a fourth
`BandEngine`," not to be one yet. `services/amt/server.py` *is* the answer
to that question turned into a real service: it imports `amt.py` and
`live_duet.py` from here unchanged and wraps them in a bar-driven WebSocket
protocol instead of this directory's own wall-clock transport.

Model: `stanford-crfm/music-small-800k` (128M params, Apache 2.0) via
Stanford CRFM's [`anticipation`](https://github.com/jthickstun/anticipation)
package. Not on PyPI — install from GitHub (see below).

## What it does

- `melody.py` — a synthetic scale-constrained melody (built with `musicpy`),
  standing in for a live player.
- `amt.py` — the model interface: event↔token encoding, a logit mask that
  restricts generation to melody (piano) plus a configurable set of
  companion instruments (`INSTRUMENT_PRESETS` — see `--voices` below)
  instead of letting a Lakh-trained checkpoint free-associate across all
  128, and a `temperature` knob (scales raw logits before `top_p`
  truncation) alongside the existing `accomp_bias`. **Default voices are a
  string ensemble** (violin, viola, cello) — empirically verified against a
  solo piano prompt, individually and together (checking the three don't
  starve each other out); see "Findings" below. Generation also reuses
  cached attention state (`_cached_logits`) across a window's ~3 tokens/note
  instead of replaying the whole prefix from scratch every time — a real
  speedup, not just a latency-bound knob, and the main reason
  `services/amt/server.py`'s per-bar latency stays usable under an ensemble
  instead of a single instrument.
- `live_duet.py` — the scheduler (`LiveDuet`) and `AccompanimentCommitter`,
  the monophonic-per-instrument commit/trim logic both this script and
  `services/amt/server.py` share. Runs a real wall-clock transport; the
  melody is only ever revealed up to the current playhead (no peeking at its
  own future), and a background thread continuously asks the model to write
  `--lookahead-beats` of accompaniment past the last committed point, of
  which only `--commit-beats` is frozen. The rest is discarded and
  regenerated once more real melody has arrived. If the model doesn't
  finish before its own deadline, that's logged as a genuine underrun, not
  hidden. If a window comes back with zero companion notes at all (a
  legitimate sample, just an unwanted one), it's retried up to
  `MAX_GENERATION_ATTEMPTS` times before being accepted as silence, and a run
  of silent windows in a row escalates `accomp_bias` (`SILENCE_BIAS_STEP`,
  capped at `MAX_SILENCE_BIAS_STEPS`) to break the model out of the lock-in
  that causes. By default each companion instrument is kept independently
  monophonic (no self-overlap, "one violin") by trimming a note's tail if
  that same instrument's next note starts before it ends — the model has no
  such constraint on its own; `--multi-voice` disables this per instrument
  ("multiple violins", a section instead of a soloist). Different
  instruments in an ensemble may always sound together regardless. Output
  is a MIDI file of exactly what was decided live. `LiveDuet` itself doesn't
  know or care where the melody comes from -- see `midi_io.py` below.
- `midi_io.py` — real MIDI hardware plumbing only (open a port, turn
  note-on/note-off into `(onset_s, dur_s, pitch)`, schedule companion notes
  to a real output at the right wall-clock time); no model code lives here.
  `live_midi.py` in the Music repo this was ported from wires it straight to
  a local `LiveDuet` (same scheduler, real keyboard instead of a synthetic
  melody) — not duplicated here since the equivalent path for Backline is
  the deployed service, below.
- `live_midi_client.py` — a real-MIDI client for **`services/amt/server.py`
  running locally**, not this directory's own `LiveDuet`: it has no
  torch/transformers/anticipation dependency at all, just `mido` +
  `websockets`, so it can run on a machine that isn't hosting the model.
  Speaks the same bar-driven protocol `src/engines/amtEngine.ts` does (see
  that file and `services/amt/server.py`'s module docstring for the wire
  format) — send `start`, forward the keyboard's notes and a `bar` message
  each bar, play back the `plan` messages that come back. See "Run against
  the service" below.

## Run (standalone, no service)

```bash
pip install torch transformers musicpy mido python-rtmidi
pip install git+https://github.com/jthickstun/anticipation.git
python live_duet.py --notes 32 --bpm 80 --lookahead-beats 2.5 --commit-beats 1.75
python live_duet.py --notes 32 --bpm 80 --voices sax --temperature 1.4 --role lead --multi-voice
# writes ../../output/bench/amt/live_duet.mid relative to this dir by default; override with --outdir
```

Flags: `--bpm`, `--key`/`--mode`, `--notes` (melody length), `--seed`,
`--lookahead-beats`, `--commit-beats`, `--top-p`, `--accomp-bias` (logit
bias toward the kept instrument(s) — free, since the alternative is always
discarded anyway). Four independent, composable knobs:

- `--voices {strings,violin,guitar,sax,brass,keys,orchestral,ambient}` —
  *which* instrument(s) play (default `strings`: violin/viola/cello). All
  eight are `amt.INSTRUMENT_PRESETS`, each empirically verified to produce
  real output against a solo piano prompt (see "Findings").
- `--multi-voice` — *how many notes at once* a given instrument may play:
  one at a time (default) or overlapping, a section rather than a soloist.
- `--temperature` (default 1.0) — how wild: scales the raw logits before
  `top_p` truncation. Below 1.0 sharpens toward the model's most confident
  guesses; above 1.0 flattens the distribution into wilder, less coherent
  pitch/rhythm choices. Distinct from `--top-p` (how much of the
  probability tail gets truncated) and `--accomp-bias` (a fixed preference
  for *which* instrument, not how sharply any of them is sampled).
- `--role {follow,lead}` (default `follow`) — `follow` waits through
  `--listen-first-beats` (default 8) before playing, always reacting to
  melody already heard; `lead` starts immediately
  (`--listen-first-beats` defaults to 0). Both still only ever generate
  from melody already revealed, so this doesn't reverse who the human/AI
  parts are — it only changes whether the companion waits for a cue to
  start. An explicit `--listen-first-beats` always overrides the role's
  default.

All flags compose freely.

## Run against the service

`services/amt/server.py` has its own model load and its own instance of
this directory's scheduling core — start it first:

```bash
cd ../../services/amt
pip install -r requirements.txt
python server.py   # listens on ws://localhost:8080/ws
```

Then, from this directory, talk to it with a real keyboard instead of
loading the model a second time:

```bash
pip install mido python-rtmidi websockets
python live_midi_client.py --list-ports
python live_midi_client.py --midi-in "Your Keyboard" --midi-out "IAC Driver Bus 1" --bpm 100
```

`--url` points it at a non-default host/port. Ctrl+C stops and writes
`../../output/bench/amt/live_midi_client_session.mid` with what was actually
played on both sides, same as `live_duet.py`'s output.

## Findings

(Ported from the Music repo's benchmarking; all measurements are from that
repo's M-series Mac/MPS sessions unless noted.)

- **A real live session went completely silent for its entire length --
  root-caused and fixed.** Every single window committed 0 notes (both
  retry attempts, every window, from the very first) in an actual session
  with a musician playing real MIDI. Reproduced directly: took the exact
  melody from that session's log and replayed it, first independently per
  window (worked fine most of the time) then *sequentially* -- each window
  building on the real (empty) accompaniment history left by the previous
  one, matching what actually happened live -- and hit the same lock-in:
  once a few windows in a row commit nothing, the model has no precedent
  for that instrument anywhere in the growing context and increasingly
  favors continuing its absence, so retrying with the same now-stuck
  context (`MAX_GENERATION_ATTEMPTS`) doesn't help. Confirmed directly
  against a stuck context pulled from that reproduction: `accomp_bias=2.0`
  (the base default) failed 4/4 trials there; 4.0-6.0 reliably broke the
  lock (1-8 notes/trial, never zero). Fixed by escalating the bias by
  `SILENCE_BIAS_STEP` per consecutive silent window (capped at
  `MAX_SILENCE_BIAS_STEPS`), resetting the moment something commits.
- **A broader instrument sweep (3 trials each, solo-masked against the same
  piano prompt) found several more usable voices beyond the string
  section:** electric piano (69 notes across 3 trials), nylon guitar (219 —
  by far the strongest single voice found), string-ensemble patch (43),
  trumpet (47), alto sax (109), flute (20), new-age pad (25), harp (20).
  `INSTRUMENT_PRESETS` (`--voices`) packages these into 8 named options so
  a caller doesn't need to know GM program numbers or which ones actually
  produce output.
- **Temperature is a real, distinct knob from `top_p`/`accomp_bias`.**
  Scaling logits by `1/temperature` before `top_p` truncation measurably
  changes both density and pitch spread on the same prompt: temperature 0.6
  produced 227 notes with pitch std 13.3 across 3 trials, 1.0 produced 30
  notes with std 9.1, 1.6 produced only 10 notes but with std 19.3 (wider,
  more scattered pitch choices) — lower temperature trends denser/safer,
  higher trends sparser/wilder, not a placebo knob.
- **Live (unbounded) sessions had an unbounded performance regression,
  fixed twice over.** Handing the model's preprocessing the *entire*
  accumulated history every cycle escalated generation time 19s → 36s → 53s
  per call over a ~4-minute test. `HISTORY_LOOKBACK_S` (90s, well above what
  the model's own ~339-event attention window could use anyway) bounds what
  `_maybe_kick_generation` clips and re-bases before handing it off, keeping
  generation time flat past 190s of music (0.3-1.3s throughout, realtime
  factor 2.44x). Separately, `_cached_logits` reuses attention state across
  a window's own sampling steps instead of replaying the whole prefix per
  token — the other half of what keeps the ensemble (below) affordable.
- **Realtime factor 1.3x-3.6x solo, ~0.6-1.0x for the 3-voice string
  ensemble** across runs on an M-series Mac/MPS, for ~1.5-2.5 beat commit
  windows at 80 BPM — net faster than real time on average for a single
  instrument, with **high per-call variance** (0.1 s-9 s for similarly sized
  chunks). A standing buffer (priming the first chunk a full lookahead
  early, plus continuous pipelining once the loop is running) absorbs most
  of that variance. Worth re-measuring on real target hardware, and worth
  tuning `--lookahead-beats`/`--commit-beats` down (or up, for more buffer
  cushion) if the ensemble underruns on yours.
- **The base checkpoint needs help to act like a duet, not a Lakh song.**
  Given only a sparse prompt, unmasked generation sprayed notes across a
  dozen-plus unrelated GM instruments — Lakh MIDI is full of multi-track
  songs, so that's an in-distribution sample, just not a useful one here.
  Masking down to a small instrument set fixes the spraying; escalating
  `accomp_bias` plus the retry-on-silence above closes most of the rest.
- **Instrument pairing is not arbitrary, but a proper string section does
  work.** A sweep over candidate GM instruments against the same piano
  prompt found wildly different note yields (e.g. violin ≈40+ notes per
  window vs. bass ≈0). Viola and cello, checked both solo-masked and
  together as a real ensemble, each produce real output individually
  (8-63 notes per 4-beat window across trials) and together (7-80 notes
  total per window, no voice starving the others out) — this is now the
  default (`STRING_ENSEMBLE_ACCOMP_INSTRS`).
- **A lone violin was consistently too sparse to hear against a real
  performance.** One real session had ~150 human notes against only 16
  companion notes in the same span, half of *those* trimmed to under 150ms
  by the monophony logic — audible as clicks at best. The 3-voice ensemble
  fixes this: more total companion notes, and since each instrument is
  independently monophonic, the combined texture still reads as clean
  individual voices rather than one instrument overlapping itself.
- **Monophony is a choice, not a constraint of the model.** `--multi-voice`
  simply skips the trim/dedup step at commit time — same generated notes,
  just not forced into a single line per instrument. Composes cleanly with
  the string ensemble (each instrument's polyphony is independent).
- **It doesn't just double the melody.** Checked one run's committed notes:
  41 accompaniment vs. 32 melody notes, only 1/41 at the exact same pitch,
  4/41 sharing a pitch class (unison/octave), and a pitch range (48-90)
  extending both above and below the melody's (60-72). No explicit
  diversity constraint is applied — this fell out of the instrument split
  and the base model's learned behavior on real multi-track songs.
  `proposal.md`'s best-of-k reranking would be the principled way to
  *guarantee* this rather than rely on it.
- **This directory's own demo (`live_duet.py`) has no input latency**
  (`proposal.md`'s delay #1) because the "performer" is synthetic Python
  events, not a transcribed instrument — it only exercises delay #2
  (inference/scheduling), which was the point. A real MIDI keyboard closes
  that gap with no transcription step needed at all — `midi_io.py` /
  `live_midi_client.py` above, or Backline's actual `Listener` via
  `src/listener/`, feeding something shaped like `LiveDuet._reveal_melody`'s
  role instead of a precomposed array. Audio input (a microphone, this
  repo's mic path) would need real pitch tracking first, with its own
  latency and error modes on top of everything measured here.

## Next steps if this becomes a real `BandEngine`

- Re-measure realtime factor on whatever hardware would actually run it
  (this was CPU/MPS on a laptop, not a GPU pod like ACE's), especially for
  the string-ensemble default.
- Best-of-k reranking (per `proposal.md`) instead of the flat accompaniment
  bias, for an actual quality/distinctiveness signal rather than a fixed
  nudge.
- Real MIDI input via `src/listener/`, feeding `LiveDuet._reveal_melody`'s
  role instead of a precomposed array (mirrors what `live_midi_client.py`
  already does against the deployed service).
