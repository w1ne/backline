"""
Proof of concept for proposal.md: a live AI duet partner.

The core claim being tested is the reframe in proposal.md -- inference
latency (100ms-1s) is not a latency problem but a *scheduling* problem,
solved by writing accompaniment a few beats ahead of the live playhead and
hiding the model's think-time behind that buffer (the ReaLJam protocol:
lookahead / commit / listen-first).

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
    MELODY_INSTR, SOLO_ACCOMP_INSTRS, ENSEMBLE_ACCOMP_INSTRS, ACCOMP_BIAS,
    make_event, parse_events, generate_duet,
)
from melody import make_synthetic_melody

# Names for the log, covering just the instruments amt.py actually offers.
INSTR_NAMES = {40: "violin", 25: "guitar"}

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


def _generate_nonsilent(model, gen_start, gen_end, commit_end, inputs, accomp_instrs, top_p, accomp_bias):
    """generate_duet, retried up to MAX_GENERATION_ATTEMPTS times if the
    commit window comes back with no accompaniment notes at all."""
    for attempt in range(1, MAX_GENERATION_ATTEMPTS + 1):
        result = generate_duet(model, gen_start, gen_end, inputs, accomp_instrs, top_p, accomp_bias)
        has_note = any(
            instr in accomp_instrs and gen_start < t <= commit_end
            for t, _, instr, _ in parse_events(result)
        )
        if has_note or attempt == MAX_GENERATION_ATTEMPTS:
            return result, attempt


class LiveDuet:
    """The scheduling loop: transport, lookahead/commit buffer, live logging.

    Knows nothing about *how* the melody is produced or *how* the model
    generates -- both are passed in, which is what keeps this swappable for
    a real MIDI input or a different model later.
    """

    def __init__(self, model, melody, melody_len_s, bpm, lookahead_beats,
                 commit_beats, listen_first_beats, top_p, accomp_instrs=SOLO_ACCOMP_INSTRS,
                 accomp_bias=ACCOMP_BIAS, polyphonic=False, poll_interval=0.05):
        self.model = model
        self.melody = melody
        self.melody_len_s = melody_len_s
        self.beat_s = 60.0 / bpm
        self.lookahead_s = lookahead_beats * self.beat_s
        self.commit_s = commit_beats * self.beat_s
        self.listen_first_s = listen_first_beats * self.beat_s
        self.top_p = top_p
        self.accomp_instrs = accomp_instrs
        self.accomp_bias = accomp_bias
        self.polyphonic = polyphonic
        self.poll_interval = poll_interval

        self.history = []            # revealed melody + committed accompaniment (raw tokens)
        self.committed_horizon = self.listen_first_s
        self.melody_idx = 0
        self.played = []             # (onset_s, dur_s, role, pitch) -- for the live log only
        self.announced = 0           # index into self.played already logged as "sounding"

        self.pool = ThreadPoolExecutor(max_workers=1)
        self.pending = None          # (future, gen_start, gen_end, wall_start)

        self.gen_stats = []          # (music_s_requested, wall_s_taken)
        self.underruns = 0
        self.t0 = None

        # Bookkeeping for monophony (self.polyphonic=False, the "one violin"
        # mode): one violin can't double-stop across notes, but the model has
        # no such constraint and will happily commit overlapping notes on the
        # same instrument. Track, per accompaniment instrument, the tail of
        # its most recently committed note so _commit_accompaniment can trim
        # it if that same voice's next note starts early. Unused entirely
        # when self.polyphonic=True ("multiple violins" -- see that method).
        self._voice_last_end = {}    # instr -> end time (s) of its last committed note
        self._voice_prev_onset = {}  # instr -> onset time (s) of its last committed note
        self._voice_dur_idx = {}     # instr -> history index of that note's duration token

    def log(self, msg):
        t = time.monotonic() - self.t0
        print(f"[{t:6.2f}s] {msg}")

    def run(self):
        self.t0 = time.monotonic()
        # How far past the end of the melody the companion is allowed to run:
        # just enough to flush whatever was already in flight when the
        # melody ended, not indefinitely. Without a cap on committed_horizon
        # (see _maybe_kick_generation), a model running faster than real
        # time keeps pipelining new windows every cycle even after there's
        # no more melody to inform them, and the piece balloons well past
        # the melody's own length purely because generation was fast.
        self.tail_s = self.lookahead_s + 2.0
        while True:
            playhead = time.monotonic() - self.t0
            done_with_melody = self.melody_idx >= len(self.melody)
            if done_with_melody and playhead > self.melody_len_s + self.tail_s:
                break

            self._reveal_melody(playhead)
            self._maybe_kick_generation(playhead)
            self._collect_generation()
            self._announce_due(playhead)

            time.sleep(self.poll_interval)

        self.pool.shutdown(wait=True)

    def _reveal_melody(self, playhead):
        while self.melody_idx < len(self.melody) and self.melody[self.melody_idx][0] <= playhead:
            onset_s, dur_s, pitch = self.melody[self.melody_idx]
            self.history.extend(make_event(onset_s, dur_s, MELODY_INSTR, pitch))
            self.played.append((onset_s, dur_s, "melody", pitch))
            self.melody_idx += 1

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
        # would otherwise keep pipelining new windows indefinitely.
        if self.committed_horizon >= self.melody_len_s + self.tail_s:
            return

        # Pipeline continuously from then on: start the next chunk the moment
        # the previous one lands, so the model is never idle while there is
        # still more accompaniment to plan.
        gen_start = self.committed_horizon
        gen_end = gen_start + self.lookahead_s
        commit_end = gen_start + self.commit_s
        hist_snapshot = list(self.history)

        wall_start = time.monotonic()
        future = self.pool.submit(
            _generate_nonsilent, self.model, gen_start, gen_end, commit_end, hist_snapshot,
            self.accomp_instrs, self.top_p, self.accomp_bias,
        )
        self.pending = (future, gen_start, gen_end, wall_start)

    def _collect_generation(self):
        if self.pending is None or not self.pending[0].done():
            return

        future, gen_start, gen_end, wall_start = self.pending
        self.pending = None
        result, attempts = future.result()
        wall_dt = time.monotonic() - wall_start
        self.gen_stats.append((gen_end - gen_start, wall_dt))

        commit_end = gen_start + self.commit_s
        committed = [
            (t, d, instr, p) for (t, d, instr, p) in parse_events(result)
            if instr in self.accomp_instrs and gen_start < t <= commit_end
        ]

        # A note is "late" if its cue has already passed by the time the
        # model finished -- a genuine scheduling underrun. In a real
        # live rig with a fixed-size playback buffer it would be inaudible;
        # here we still keep it (at its original musical position) so the
        # MIDI reflects what the model actually wrote, and count it below so
        # the underrun rate stays an honest measure of real-time viability.
        collect_time = time.monotonic() - self.t0
        late = sum(1 for (t, _, _, _) in committed if t < collect_time)

        self._commit_accompaniment(committed)
        self.committed_horizon = commit_end

        tag = "ok" if not late else f"UNDERRUN ({late} note(s) arrived after their cue)"
        self.underruns += 1 if late else 0
        retry_note = f", {attempts} attempt(s)" if attempts > 1 else ""
        self.log(
            f"model wrote [{gen_start:5.2f}s..{gen_end:5.2f}s) in {wall_dt:4.2f}s wall time{retry_note}, "
            f"committed {len(committed)} note(s) up to {commit_end:5.2f}s -- {tag}"
        )

    def _commit_accompaniment(self, notes):
        """Append accompaniment notes to history/played.

        In "one violin" mode (self.polyphonic=False, the default): one note
        at a time per instrument. An ensemble's different instruments are
        independent voices and may overlap each other, but no single
        instrument may overlap itself -- if a note starts before that same
        instrument's previous note has finished ringing, the previous note's
        duration is trimmed to meet it, same as note-stealing on a
        monophonic synth. This only ever shortens a note that's already
        committed; it never moves an onset or changes a pitch, so it doesn't
        revisit the musical decisions the scheduler already froze. Two notes
        on the same instrument landing on the exact same 10ms tick (the
        model's finest time resolution) can't be told apart at all -- keep
        the earlier, drop the rest, rather than emit a technically-nonzero
        but inaudible sliver.

        In "multiple violins" mode (self.polyphonic=True): committed exactly
        as generated, self-overlaps included -- a section, not a soloist.
        """
        for onset_s, dur_s, instr, pitch in sorted(notes):
            onset_s = round(onset_s * TIME_RESOLUTION) / TIME_RESOLUTION  # same tick grid as make_event

            if not self.polyphonic:
                prev_onset = self._voice_prev_onset.get(instr)
                if prev_onset is not None:
                    if onset_s <= prev_onset:
                        continue
                    if onset_s < self._voice_last_end[instr]:
                        trimmed_s = onset_s - prev_onset
                        self.history[self._voice_dur_idx[instr]] = DUR_OFFSET + round(trimmed_s * TIME_RESOLUTION)

            self.history.extend(make_event(onset_s, dur_s, instr, pitch))

            if not self.polyphonic:
                self._voice_dur_idx[instr] = len(self.history) - 2  # the triple's middle (duration) slot
                self._voice_prev_onset[instr] = onset_s
                self._voice_last_end[instr] = onset_s + dur_s

            self.played.append((onset_s, dur_s, f"accomp:{instr}", pitch))

    def _announce_due(self, playhead):
        while self.announced < len(self.played) and self.played[self.announced][0] <= playhead:
            onset_s, dur_s, role, pitch = self.played[self.announced]
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
    ap.add_argument("--listen-first-beats", type=float, default=8.0)
    ap.add_argument("--top-p", type=float, default=0.95)
    ap.add_argument("--accomp-bias", type=float, default=ACCOMP_BIAS,
                     help="logit bias favoring the accompaniment instrument(s) over the "
                          "hallucinated-melody instrument (no coherence cost since the "
                          "latter is always discarded)")
    ap.add_argument("--ensemble", action="store_true",
                     help="use both empirically-verified companion voices (violin + steel "
                          "guitar) instead of one violin -- which instrument(s) play, "
                          "orthogonal to --multi-voice below")
    ap.add_argument("--multi-voice", action="store_true",
                     help="\"multiple violins\": let each companion instrument overlap "
                          "itself (a section, not a soloist) instead of enforcing one note "
                          "at a time per instrument -- how many notes a given instrument "
                          "can play at once, orthogonal to --ensemble above")
    ap.add_argument("--outdir", default=str(Path(__file__).resolve().parent.parent.parent / "output"))
    args = ap.parse_args()

    accomp_instrs = ENSEMBLE_ACCOMP_INSTRS if args.ensemble else SOLO_ACCOMP_INSTRS

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
          f"listen_first={args.listen_first_beats} beats")
    voices = ", ".join(INSTR_NAMES.get(i, str(i)) for i in accomp_instrs)
    voicing = "polyphonic (multiple violins)" if args.multi_voice else "monophonic (one violin)"
    print(f"companion voice(s): {voices} -- {voicing}")

    # A real product warms up its model before the audience arrives, not
    # during the performance -- the first MPS/CUDA call always eats a large,
    # one-off graph-compilation tax that has nothing to do with steady-state
    # inference speed. Soundcheck, not showtime.
    print("soundcheck: warming up the model (not part of the timed performance) ...")
    warm_start = time.monotonic()
    dummy = [t for onset, dur, pitch in melody[:6] for t in make_event(onset, dur, MELODY_INSTR, pitch)]
    generate_duet(model, melody[5][0] + melody[5][1], melody[5][0] + melody[5][1] + beat_s,
                  dummy, accomp_instrs, args.top_p, args.accomp_bias)
    print(f"soundcheck done in {time.monotonic() - warm_start:.2f}s")

    print("--- live performance starts now (real wall-clock time) ---")

    duet = LiveDuet(
        model=model,
        melody=melody,
        melody_len_s=melody_len_s,
        bpm=args.bpm,
        lookahead_beats=args.lookahead_beats,
        commit_beats=args.commit_beats,
        listen_first_beats=args.listen_first_beats,
        top_p=args.top_p,
        accomp_instrs=accomp_instrs,
        accomp_bias=args.accomp_bias,
        polyphonic=args.multi_voice,
    )
    duet.run()

    print("--- live performance ended ---")

    total_music_s = sum(m for m, _ in duet.gen_stats)
    total_wall_s = sum(w for _, w in duet.gen_stats)
    rtf = total_music_s / total_wall_s if total_wall_s > 0 else float("inf")
    print(
        f"inference calls: {len(duet.gen_stats)}, "
        f"music generated: {total_music_s:.1f}s in {total_wall_s:.1f}s wall time "
        f"(realtime factor {rtf:.2f}x), underruns: {duet.underruns}"
    )

    midi_path = outdir / "live_duet.mid"
    events_to_midi(ops.sort(duet.history)).save(str(midi_path))
    print(f"wrote {midi_path}")


if __name__ == "__main__":
    main()
