"""
Proof of concept for proposal.md: a live AI duet partner.

The core claim being tested is the reframe in proposal.md -- inference
latency (100ms-1s) is not a latency problem but a *scheduling* problem,
solved by writing accompaniment a few beats ahead of the live playhead and
hiding the model's think-time behind that buffer (the ReaLJam protocol this
repo's Lyria/ACE engines already use in spirit: lookahead, commit,
listen-first). This is a from-scratch Python prototype, independent of
`src/engines/` -- it exists to answer "is this model viable as a fourth
`BandEngine`," not to be one yet.

This script treats the run as a genuine live recording, not an offline batch
job:

  * A synthetic melody (melody.py) plays in real wall-clock time. The
    scheduler is only ever shown notes whose onset has already passed -- it
    cannot see the future of its own "performer".
  * A background worker continuously asks the Anticipatory Music Transformer
    (amt.py) to write `lookahead` beats of accompaniment past the last
    committed point. Per the model's training trick, it actually predicts
    *both* parts jointly; we keep only its accompaniment-instrument notes
    and throw the hallucinated melody continuation away.
  * Only the first `commit` beats of each new chunk are frozen into the
    performance. The remainder is discarded and regenerated next cycle once
    more real melody has arrived -- this is what keeps the accompaniment
    stable under the player's fingers instead of twitching.
  * If the model doesn't finish before the buffer drains, that's a real
    scheduling underrun, and it is logged as one instead of being hidden.
  * By default each companion instrument is kept monophonic ("one violin"),
    trimming a note's tail if that same instrument's next note starts early
    -- the model has no such constraint on its own. --multi-voice disables
    this ("multiple violins": a section, not a soloist).

At the end, the exact sequence of decisions made live (no post-hoc cleanup)
is written out as a MIDI file.
"""

import argparse
import heapq
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import torch
from transformers import AutoModelForCausalLM

from anticipation import ops
from anticipation.config import TIME_RESOLUTION
from anticipation.convert import events_to_midi
from anticipation.vocab import DUR_OFFSET

from amt import (
    MELODY_INSTR, STRING_ENSEMBLE_ACCOMP_INSTRS, INSTRUMENT_PRESETS, ACCOMP_BIAS,
    make_event, parse_events, generate_duet,
)
from melody import make_synthetic_melody

# Names for the log, covering every instrument INSTRUMENT_PRESETS offers.
INSTR_NAMES = {
    40: "violin", 41: "viola", 42: "cello", 24: "guitar", 65: "sax",
    56: "trumpet", 4: "keys", 48: "string-ensemble", 46: "harp",
    88: "pad", 73: "flute",
}

# Writing zero accompaniment notes in a window is a legitimate sample (the
# model is free to spend the whole window "predicting" more piano), but a
# run of them in a row leaves the companion audibly silent. Pushing the
# instrument bias ever higher to make that statistically rarer turns out to
# be unreliable -- it's noisy and non-monotonic across runs (verified by
# sweeping bias 2-10 across several melodies: higher bias raised average
# density but individual runs still landed double-digit-second silent
# stretches, and 8.0 was sometimes worse than 6.0). Simply re-rolling a
# window that came back empty is more direct and bounded; 2 attempts was the
# best tradeoff found -- 4 attempts multiplies worst-case generation time
# enough to blow the scheduling buffer (near-100% underrun on one melody).
MAX_GENERATION_ATTEMPTS = 2

# Once the accompaniment has gone silent for a few windows in a row, it
# tends to *stay* silent: with no precedent for that instrument anywhere in
# the growing context, the model increasingly favors continuing that
# absence, and retrying with the same stuck context (MAX_GENERATION_ATTEMPTS
# above) doesn't help since nothing about the prompt has changed. Verified
# directly against a real stuck context from an actual session that went
# fully silent: accomp_bias=2.0 (the base default) failed 4/4 trials there;
# 4.0-6.0 reliably broke the lock (1-8 notes/trial, never zero). Escalating
# the bias after consecutive silent windows, and resetting the moment
# something commits, targets exactly this lock-in without permanently
# raising the bias (which would just make it a slower version of the same
# non-monotonic problem noted above).
SILENCE_BIAS_STEP = 1.5
MAX_SILENCE_BIAS_STEPS = 4

# amt._add_token already only looks at the model's own trailing ~1017-token
# (~339-event) context window internally -- anything older is invisible to
# it anyway. Without this, _maybe_kick_generation hands the model's
# preprocessing (sort/clip/pad, all O(history length)) the *entire* history
# every single cycle, which is invisible for a short synthetic demo but is a
# genuine, measured bug for an unbounded live session: generation time
# escalated 19s -> 36s -> 53s per call over one ~4-minute test as history
# kept growing, well past anything the model could even use. 90s is
# generously above what ~339 events could span at any realistic note
# density, so nothing musically relevant is lost by not looking further back
# than this before generation even starts.
HISTORY_LOOKBACK_S = 90.0


def _generate_nonsilent(model, gen_start, gen_end, commit_end, inputs, accomp_instrs, top_p,
                         accomp_bias, temperature):
    """generate_duet, retried up to MAX_GENERATION_ATTEMPTS times if the
    commit window comes back with no accompaniment notes at all."""
    for attempt in range(1, MAX_GENERATION_ATTEMPTS + 1):
        result = generate_duet(model, gen_start, gen_end, inputs, accomp_instrs, top_p, accomp_bias, temperature)
        has_note = any(
            instr in accomp_instrs and gen_start <= t < commit_end
            for t, _, instr, _ in parse_events(result)
        )
        if has_note or attempt == MAX_GENERATION_ATTEMPTS:
            return result, attempt


class SyntheticMelodySource:
    """Wraps a precomputed (onset_s, dur_s, pitch) list -- melody.py's
    output -- behind the same poll/exhausted interface a real MIDI keyboard
    input exposes (see midi_io.MidiKeyboardInput), so LiveDuet doesn't need
    to know or care which one it's talking to."""

    def __init__(self, melody):
        self._melody = melody
        self._idx = 0

    def poll(self, playhead):
        new = []
        while self._idx < len(self._melody) and self._melody[self._idx][0] <= playhead:
            new.append(self._melody[self._idx])
            self._idx += 1
        return new

    def exhausted(self):
        return self._idx >= len(self._melody)


class AccompanimentCommitter:
    """Commits generated accompaniment notes into a token history, trimming
    an earlier note's tail if the next note on the *same instrument* starts
    before it ends (monophonic note-stealing, per voice) -- an ensemble's
    different instruments are independent voices and may overlap each
    other, but no single instrument may overlap itself unless
    polyphonic=True. This only ever shortens a note that's already
    committed; it never moves an onset or changes a pitch, so it doesn't
    revisit the musical decisions the scheduler already froze. Two notes on
    the same instrument landing on the exact same 10ms tick (the model's
    finest time resolution) can't be told apart at all -- keep the earlier,
    drop the rest, rather than emit a technically-nonzero but inaudible
    sliver.

    Pulled out of LiveDuet._commit_accompaniment so a caller that doesn't
    run the wall-clock transport (e.g. a bar-driven WebSocket server) can
    reuse the exact same commit/trim behavior as a plain library call.
    """

    def __init__(self, history, polyphonic=False, on_trim=None):
        self.history = history
        self.polyphonic = polyphonic
        self.on_trim = on_trim or (lambda instr, trimmed_dur_s: None)
        self._last_end = {}    # instr -> end time (s) of its last committed note
        self._prev_onset = {}  # instr -> onset time (s) of its last committed note
        self._dur_idx = {}     # instr -> history index of that note's duration token

    def drop_prefix(self, n_tokens):
        """Tell the committer that `n_tokens` tokens were removed from the front of the
        shared history list, so the indices it keeps into that list stay valid.

        A caller that prunes its context window (the WebSocket service does, to keep the
        model's prompt -- and so its per-bar latency -- from growing all session) would
        otherwise leave `_dur_idx` pointing at the wrong triple, and the next trim would
        rewrite an unrelated note's duration. If the note an instrument's index pointed at
        was itself pruned there is nothing left to trim against, so that instrument's trim
        state is simply dropped.
        """
        for instr in list(self._dur_idx):
            self._dur_idx[instr] -= n_tokens
            if self._dur_idx[instr] < 0:
                del self._dur_idx[instr]
                self._prev_onset.pop(instr, None)
                self._last_end.pop(instr, None)

    def commit(self, notes):
        """Append accompaniment notes (onset_s, dur_s, instr, pitch) to self.history.

        Returns the list of (onset_s, dur_s, instr, pitch) actually committed, after
        trimming/dropping, in the same shape as the input.
        """
        committed = []
        for onset_s, dur_s, instr, pitch in sorted(notes):
            onset_s = round(onset_s * TIME_RESOLUTION) / TIME_RESOLUTION  # same tick grid as make_event

            if not self.polyphonic:
                prev_onset = self._prev_onset.get(instr)
                if prev_onset is not None:
                    if onset_s <= prev_onset:
                        continue
                    if onset_s < self._last_end[instr]:
                        trimmed_s = onset_s - prev_onset
                        self.history[self._dur_idx[instr]] = DUR_OFFSET + round(trimmed_s * TIME_RESOLUTION)
                        self.on_trim(instr, trimmed_s)

            self.history.extend(make_event(onset_s, dur_s, instr, pitch))

            if not self.polyphonic:
                self._dur_idx[instr] = len(self.history) - 2  # the triple's middle (duration) slot
                self._prev_onset[instr] = onset_s
                self._last_end[instr] = onset_s + dur_s

            committed.append((onset_s, dur_s, instr, pitch))
        return committed


class LiveDuet:
    """The scheduling loop: transport, lookahead/commit buffer, live logging.

    Knows nothing about *how* the melody is produced (melody_source is
    SyntheticMelodySource for the demo, midi_io.MidiKeyboardInput for a real
    keyboard -- both expose the same poll(playhead)/exhausted() shape) or
    *how* the model generates, which is what keeps this swappable for a
    real MIDI input or a different model without touching the scheduler.

    melody_len_s=None means an unbounded live session: the only way to stop
    is request_stop() (see live_midi.py's Ctrl+C handler), since there's no
    known length to run a tail past.
    """

    def __init__(self, model, melody_source, melody_len_s, bpm, lookahead_beats,
                 commit_beats, listen_first_beats, top_p, accomp_instrs=STRING_ENSEMBLE_ACCOMP_INSTRS,
                 accomp_bias=ACCOMP_BIAS, temperature=1.0, polyphonic=False, on_played=None, t0=None,
                 poll_interval=0.05):
        if bpm <= 0 or commit_beats <= 0 or lookahead_beats < commit_beats:
            raise ValueError("Require bpm > 0 and 0 < commit beats <= lookahead beats")
        if listen_first_beats < 0:
            raise ValueError("Listen-first beats must be >= 0")
        if not 0 < top_p <= 1:
            raise ValueError("top_p must be in (0, 1]")
        self.model = model
        self.melody_source = melody_source
        self.melody_len_s = melody_len_s
        self.beat_s = 60.0 / bpm
        self.lookahead_s = lookahead_beats * self.beat_s
        self.commit_s = commit_beats * self.beat_s
        self.listen_first_s = listen_first_beats * self.beat_s
        self.top_p = top_p
        self.accomp_instrs = accomp_instrs
        self.accomp_bias = accomp_bias
        self.temperature = temperature
        self.polyphonic = polyphonic
        self.on_played = on_played or (lambda onset_s, dur_s, role, pitch: None)
        self.poll_interval = poll_interval

        self.history = []            # revealed melody + committed accompaniment (raw tokens)
        self.committed_horizon = self.listen_first_s
        self.played = []             # (onset_s, dur_s, role, pitch) -- for the live log only
        self._melody_refs = {}       # live note id -> (duration token index, played index)
        self._voice_played_idx = {}  # instr -> index into self.played of its last committed note
        self._announcements = []
        self.announced = 0           # count of events announced in onset order
        self._stop_requested = False

        self.pool = ThreadPoolExecutor(max_workers=1)
        self.pending = None          # (future, gen_start, gen_end, wall_start, window_start)

        self.gen_stats = []          # (committed timeline seconds, wall seconds)
        self.underruns = 0
        self._consecutive_silent = 0  # windows in a row that committed nothing; see SILENCE_BIAS_STEP
        self.dropped_expired = 0
        # Normally set fresh in run(). Injectable so a caller (live_midi.py)
        # can open real MIDI ports against the exact same clock *before*
        # the blocking run() call starts -- there's no other way to hand
        # them a consistent t0 once run() is already looping.
        self.t0 = t0

        # Monophony (self.polyphonic=False, the "one violin" mode) is delegated to
        # AccompanimentCommitter; on_trim keeps self.played's log entry in sync with
        # the trim it makes to self.history.
        self._committer = AccompanimentCommitter(self.history, self.polyphonic, self._on_trim)

    def _on_trim(self, instr, trimmed_dur_s):
        idx = self._voice_played_idx.get(instr)
        if idx is None:
            return
        previous = self.played[idx]
        self.played[idx] = (previous[0], trimmed_dur_s, previous[2], previous[3])

    def log(self, msg):
        t = time.monotonic() - self.t0
        print(f"[{t:6.2f}s] {msg}")

    def request_stop(self):
        """Ask the loop to stop at its next iteration (within one
        poll_interval) instead of running to melody_len_s + tail_s, and
        return from run() normally so callers can still export a MIDI file
        etc. afterward. The only way to end an unbounded live session
        (melody_len_s=None) -- see live_midi.py's Ctrl+C handler."""
        self._stop_requested = True

    def run(self):
        self.t0 = self.t0 or time.monotonic()
        # How far past the end of the melody the companion is allowed to run:
        # just enough to flush whatever was already in flight when the
        # melody ended, not indefinitely. Without a cap on committed_horizon
        # (see _maybe_kick_generation), a model running faster than real
        # time keeps pipelining new windows every cycle even after there's
        # no more melody to inform them, and the piece balloons well past
        # the melody's own length purely because generation was fast.
        self.tail_s = self.lookahead_s + 2.0
        try:
            while not self._stop_requested:
                playhead = time.monotonic() - self.t0
                if self.melody_len_s is not None and self.melody_source.exhausted() \
                        and playhead > self.melody_len_s + self.tail_s:
                    break
                self._reveal_melody(playhead)
                self._collect_generation()
                self._maybe_kick_generation(playhead)
                self._announce_due(playhead)
                time.sleep(self.poll_interval)
        finally:
            # Let the caller silence hardware immediately. An in-flight model call
            # cannot be interrupted safely; its result will no longer be played.
            self.pool.shutdown(wait=False, cancel_futures=True)

    def _reveal_melody(self, playhead):
        for event in self.melody_source.poll(playhead):
            if isinstance(event, dict):
                onset_s, dur_s, pitch = event["onset"], event["duration"], event["pitch"]
                note_id = event["id"]
                refs = self._melody_refs.get(note_id)
                if refs is not None:
                    dur_idx, played_idx = refs
                    self.history[dur_idx] = make_event(onset_s, dur_s, MELODY_INSTR, pitch)[1]
                    self.played[played_idx] = (onset_s, dur_s, "melody", pitch)
                    if event["complete"]:
                        del self._melody_refs[note_id]
                    continue
            else:
                onset_s, dur_s, pitch = event
                note_id = None
            self.history.extend(make_event(onset_s, dur_s, MELODY_INSTR, pitch))
            self.played.append((onset_s, dur_s, "melody", pitch))
            if note_id is not None and not event["complete"]:
                self._melody_refs[note_id] = (len(self.history) - 2, len(self.played) - 1)
            heapq.heappush(self._announcements, (onset_s, len(self.played) - 1))
            self.on_played(onset_s, dur_s, "melody", pitch)

    def _maybe_kick_generation(self, playhead):
        if self.pending is not None:
            return
        # Start priming the very first chunk a full lookahead early, so it has
        # a wall-clock cushion in hand before its notes are actually due
        # rather than racing the playhead from a standing start.
        if playhead < self.listen_first_s - self.lookahead_s:
            return

        # Stop asking for more once we've already planned past the end of the
        # melody's tail: there's no more melody to inform further windows
        # anyway, and without this a model running faster than real time
        # would otherwise keep pipelining new windows indefinitely. Doesn't
        # apply to an unbounded live session (melody_len_s=None) -- there's
        # always more melody potentially coming until the player stops.
        if self.melody_len_s is not None and self.committed_horizon >= self.melody_len_s + self.tail_s:
            return

        # Keep committed audio close to the performer. A fast model must wait
        # for fresh input rather than accumulating minutes of frozen music.
        # Keep at most lookahead + one commit ahead; lookahead is the
        # compute cushion before the next window begins.
        if self.committed_horizon > playhead + self.lookahead_s:
            return
        # After an underrun, recover at the current transport instead of spending
        # subsequent calls generating windows that are already in the past.
        gen_start = max(self.committed_horizon, playhead)
        gen_end = gen_start + self.lookahead_s
        commit_end = gen_start + self.commit_s

        # Bound what gets handed to the model to a recent window (see
        # HISTORY_LOOKBACK_S above), and re-base it to start near zero.
        # Rebasing matters, not just clipping: anticipation.ops.pad pads
        # silence from absolute time zero up to the first real event, so
        # without this an old absolute gen_start (e.g. 150s into a long live
        # session) would still make padding -- and everything downstream of
        # it -- scale with total session length even after clipping the
        # event list itself.
        window_start = max(0.0, gen_start - HISTORY_LOOKBACK_S)
        hist_snapshot = ops.clip(self.history, window_start, gen_start, clip_duration=False)
        if window_start > 0:
            hist_snapshot = ops.translate(hist_snapshot, -window_start, seconds=True)

        escalated_bias = self.accomp_bias + SILENCE_BIAS_STEP * min(
            self._consecutive_silent, MAX_SILENCE_BIAS_STEPS,
        )

        wall_start = time.monotonic()
        future = self.pool.submit(
            _generate_nonsilent, self.model, gen_start - window_start, gen_end - window_start,
            commit_end - window_start, hist_snapshot, self.accomp_instrs, self.top_p, escalated_bias,
            self.temperature,
        )
        self.pending = (future, gen_start, gen_end, wall_start, window_start)

    def _collect_generation(self):
        if self.pending is None or not self.pending[0].done():
            return

        future, gen_start, gen_end, wall_start, window_start = self.pending
        self.pending = None
        result, attempts = future.result()
        if window_start > 0:
            result = ops.translate(result, window_start, seconds=True)  # back to absolute time
        wall_dt = time.monotonic() - wall_start
        self.gen_stats.append((self.commit_s, wall_dt))

        commit_end = gen_start + self.commit_s
        committed = [
            (t, d, instr, p) for (t, d, instr, p) in parse_events(result)
            if instr in self.accomp_instrs and gen_start <= t < commit_end
        ]

        # Count late model output before dropping/shortening expired events,
        # so recovery never hides a missed playback deadline in the statistics.
        collect_time = time.monotonic() - self.t0
        late = sum(1 for (t, _, _, _) in committed if t < collect_time)

        # Never send expired notes as an audible burst. Notes that are still
        # useful enter now and retain their original end, matching live playback.
        audible = []
        for t, d, instr, p in committed:
            if t + d <= collect_time:
                self.dropped_expired += 1
                continue
            onset = max(t, collect_time)
            audible.append((onset, t + d - onset, instr, p))
        self._commit_accompaniment(audible)
        self.committed_horizon = commit_end

        if committed:
            self._consecutive_silent = 0
        else:
            self._consecutive_silent += 1

        tag = "ok" if not late else f"UNDERRUN ({late} note(s) arrived after their cue)"
        self.underruns += 1 if late else 0
        retry_note = f", {attempts} attempt(s)" if attempts > 1 else ""
        silent_note = f", {self._consecutive_silent} silent window(s) in a row" if self._consecutive_silent > 1 else ""
        self.log(
            f"model wrote [{gen_start:5.2f}s..{gen_end:5.2f}s) in {wall_dt:4.2f}s wall time{retry_note}, "
            f"committed {len(committed)} note(s) up to {commit_end:5.2f}s -- {tag}{silent_note}"
        )

    def _commit_accompaniment(self, notes):
        """Commit accompaniment notes via AccompanimentCommitter, then log each
        into self.played for the live announcer.

        In "one violin" mode (self.polyphonic=False, the default): one note at a
        time per instrument. An ensemble's different instruments are independent
        voices and may overlap each other, but no single instrument may overlap
        itself -- the committer trims a note's tail if that same instrument's
        next note starts before it ends, same as note-stealing on a monophonic
        synth. In "multiple violins" mode (self.polyphonic=True): committed
        exactly as generated, self-overlaps included -- a section, not a soloist.
        """
        for onset_s, dur_s, instr, pitch in self._committer.commit(notes):
            role = f"accomp:{instr}"
            self._voice_played_idx[instr] = len(self.played)
            self.played.append((onset_s, dur_s, role, pitch))
            heapq.heappush(self._announcements, (onset_s, len(self.played) - 1))
            self.on_played(onset_s, dur_s, role, pitch)

    def _announce_due(self, playhead):
        while self._announcements and self._announcements[0][0] <= playhead:
            _, idx = heapq.heappop(self._announcements)
            onset_s, dur_s, role, pitch = self.played[idx]
            if role == "melody":
                marker = "YOU        "
            else:
                instr = int(role.split(":")[1])
                marker = f"AI({INSTR_NAMES.get(instr, instr)})".ljust(11)
            self.log(f"{marker} pitch={pitch:3d} dur={dur_s:4.2f}s")
            self.announced += 1


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--bpm", type=float, default=80.0)
    ap.add_argument("--key", default="C")
    ap.add_argument("--mode", default="major")
    ap.add_argument("--notes", type=int, default=32, help="length of the synthetic melody")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--lookahead-beats", type=float, default=3.0)
    ap.add_argument("--commit-beats", type=float, default=1.5)
    ap.add_argument("--listen-first-beats", type=float, default=None,
                     help="beats of silence before the companion plays its first note "
                          "(default: 8 for --role follow, 0 for --role lead)")
    ap.add_argument("--top-p", type=float, default=0.95)
    ap.add_argument("--temperature", type=float, default=1.0,
                     help="how wild the companion should be: scales the model's raw logits "
                          "before sampling. Below 1.0 sharpens toward its most confident "
                          "guesses (safer, more predictable); above 1.0 flattens the "
                          "distribution (wilder pitch/rhythm choices, less coherent). "
                          "Distinct from --top-p (how much of the tail gets truncated) and "
                          "--accomp-bias (a fixed preference for which instrument)")
    ap.add_argument("--accomp-bias", type=float, default=ACCOMP_BIAS,
                     help="logit bias favoring the accompaniment instrument(s) over the "
                          "hallucinated-melody instrument (no coherence cost since the "
                          "latter is always discarded)")
    ap.add_argument("--voices", choices=sorted(INSTRUMENT_PRESETS), default="strings",
                     help="which instrument(s) play the companion part (default: strings -- "
                          "violin/viola/cello; a lone violin was consistently too sparse "
                          "against a real performance to be heard). Orthogonal to --multi-voice.")
    ap.add_argument("--multi-voice", action="store_true",
                     help="let each companion instrument overlap itself (a section, not a "
                          "soloist) instead of enforcing one note at a time per instrument -- "
                          "how many notes a given instrument can play at once, orthogonal to "
                          "--voices above")
    ap.add_argument("--role", choices=["follow", "lead"], default="follow",
                     help="follow (default): wait through --listen-first-beats before playing "
                          "a note, always reacting to melody that's already been heard. lead: "
                          "start immediately (--listen-first-beats defaults to 0) instead of "
                          "waiting to hear you first. Both still only ever generate from melody "
                          "already revealed -- this doesn't reverse who the human/AI parts are, "
                          "just whether the companion waits for a cue to start")
    ap.add_argument("--outdir", default=str(Path(__file__).resolve().parent.parent.parent / "output" / "bench" / "amt"))
    args = ap.parse_args()

    accomp_instrs = INSTRUMENT_PRESETS[args.voices]
    listen_first_beats = args.listen_first_beats
    if listen_first_beats is None:
        listen_first_beats = 0.0 if args.role == "lead" else 8.0

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"loading stanford-crfm/music-small-800k on {device} ...")
    model = AutoModelForCausalLM.from_pretrained("stanford-crfm/music-small-800k").to(device)
    model.eval()

    beat_s = 60.0 / args.bpm
    melody, melody_len_s = make_synthetic_melody(
        key=args.key, mode=args.mode, n_notes=args.notes, beat_s=beat_s, seed=args.seed,
    )
    print(f"synthetic melody: {len(melody)} notes, {melody_len_s:.1f}s @ {args.bpm} bpm "
          f"({args.key} {args.mode}, seed={args.seed})")
    print(f"scheduler: lookahead={args.lookahead_beats} beats, commit={args.commit_beats} beats, "
          f"listen_first={listen_first_beats} beats, role={args.role}")
    voices = ", ".join(INSTR_NAMES.get(i, str(i)) for i in accomp_instrs)
    voicing = "polyphonic" if args.multi_voice else "monophonic"
    print(f"companion voice(s): {voices} ({args.voices}) -- {voicing}, temperature={args.temperature}")

    # A real product warms up its model before the audience arrives, not
    # during the performance -- the first MPS/CUDA call always eats a large,
    # one-off graph-compilation tax that has nothing to do with steady-state
    # inference speed. Soundcheck, not showtime.
    print("soundcheck: warming up the model (not part of the timed performance) ...")
    warm_start = time.monotonic()
    dummy = [t for onset, dur, pitch in melody[:6] for t in make_event(onset, dur, MELODY_INSTR, pitch)]
    generate_duet(model, melody[5][0] + melody[5][1], melody[5][0] + melody[5][1] + beat_s,
                  dummy, accomp_instrs, args.top_p, args.accomp_bias, args.temperature)
    print(f"soundcheck done in {time.monotonic() - warm_start:.2f}s")

    print("--- live performance starts now (real wall-clock time) ---")

    duet = LiveDuet(
        model=model,
        melody_source=SyntheticMelodySource(melody),
        melody_len_s=melody_len_s,
        bpm=args.bpm,
        lookahead_beats=args.lookahead_beats,
        commit_beats=args.commit_beats,
        listen_first_beats=listen_first_beats,
        top_p=args.top_p,
        accomp_instrs=accomp_instrs,
        accomp_bias=args.accomp_bias,
        temperature=args.temperature,
        polyphonic=args.multi_voice,
    )
    duet.run()

    print("--- live performance ended ---")

    total_music_s = sum(m for m, _ in duet.gen_stats)
    total_wall_s = sum(w for _, w in duet.gen_stats)
    rtf = total_music_s / total_wall_s if total_wall_s > 0 else float("inf")
    print(
        f"inference calls: {len(duet.gen_stats)}, "
        f"music committed: {total_music_s:.1f}s in {total_wall_s:.1f}s wall time "
        f"(committed-time throughput {rtf:.2f}x), underruns: {duet.underruns}, expired notes dropped: {duet.dropped_expired}"
    )

    midi_path = outdir / "live_duet.mid"
    events_to_midi(ops.sort(duet.history)).save(str(midi_path))
    print(f"wrote {midi_path}")


if __name__ == "__main__":
    main()
