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
from anticipation.convert import events_to_midi

from amt import MELODY_INSTR, ACCOMP_INSTR, ACCOMP_BIAS, make_event, parse_events, generate_duet
from melody import make_synthetic_melody


class LiveDuet:
    """The scheduling loop: transport, lookahead/commit buffer, live logging.

    Knows nothing about *how* the melody is produced or *how* the model
    generates -- both are passed in, which is what keeps this swappable for
    a real MIDI input or a different model later.
    """

    def __init__(self, model, melody, melody_len_s, bpm, lookahead_beats,
                 commit_beats, listen_first_beats, top_p, accomp_bias=ACCOMP_BIAS,
                 poll_interval=0.05):
        self.model = model
        self.melody = melody
        self.melody_len_s = melody_len_s
        self.beat_s = 60.0 / bpm
        self.lookahead_s = lookahead_beats * self.beat_s
        self.commit_s = commit_beats * self.beat_s
        self.listen_first_s = listen_first_beats * self.beat_s
        self.top_p = top_p
        self.accomp_bias = accomp_bias
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

    def log(self, msg):
        t = time.monotonic() - self.t0
        print(f"[{t:6.2f}s] {msg}")

    def run(self):
        self.t0 = time.monotonic()
        tail_s = self.lookahead_s + 2.0
        while True:
            playhead = time.monotonic() - self.t0
            done_with_melody = self.melody_idx >= len(self.melody)
            if done_with_melody and playhead > self.melody_len_s + tail_s:
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

        # Pipeline continuously from then on: start the next chunk the moment
        # the previous one lands, so the model is never idle while there is
        # still more accompaniment to plan.
        gen_start = self.committed_horizon
        gen_end = gen_start + self.lookahead_s
        hist_snapshot = list(self.history)

        wall_start = time.monotonic()
        future = self.pool.submit(
            generate_duet, self.model, gen_start, gen_end, hist_snapshot,
            self.top_p, self.accomp_bias,
        )
        self.pending = (future, gen_start, gen_end, wall_start)

    def _collect_generation(self):
        if self.pending is None or not self.pending[0].done():
            return

        future, gen_start, gen_end, wall_start = self.pending
        self.pending = None
        result = future.result()
        wall_dt = time.monotonic() - wall_start
        self.gen_stats.append((gen_end - gen_start, wall_dt))

        commit_end = gen_start + self.commit_s
        committed = [
            (t, d, p) for (t, d, instr, p) in parse_events(result)
            if instr == ACCOMP_INSTR and gen_start < t <= commit_end
        ]

        # A note is "late" if its cue has already passed by the time the
        # model finished -- a genuine scheduling underrun. In a real
        # live rig with a fixed-size playback buffer it would be inaudible;
        # here we still keep it (at its original musical position) so the
        # MIDI reflects what the model actually wrote, and count it below so
        # the underrun rate stays an honest measure of real-time viability.
        collect_time = time.monotonic() - self.t0
        late = sum(1 for (t, _, _) in committed if t < collect_time)

        for onset_s, dur_s, pitch in committed:
            self.history.extend(make_event(onset_s, dur_s, ACCOMP_INSTR, pitch))
            self.played.append((onset_s, dur_s, "accompaniment", pitch))

        self.committed_horizon = commit_end

        tag = "ok" if not late else f"UNDERRUN ({late} note(s) arrived after their cue)"
        self.underruns += 1 if late else 0
        self.log(
            f"model wrote [{gen_start:5.2f}s..{gen_end:5.2f}s) in {wall_dt:4.2f}s wall time, "
            f"committed {len(committed)} note(s) up to {commit_end:5.2f}s -- {tag}"
        )

    def _announce_due(self, playhead):
        while self.announced < len(self.played) and self.played[self.announced][0] <= playhead:
            onset_s, dur_s, role, pitch = self.played[self.announced]
            marker = "YOU " if role == "melody" else "AI  "
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
                     help="logit bias favoring the accompaniment instrument over the "
                          "hallucinated-melody instrument (no coherence cost since the "
                          "latter is always discarded)")
    ap.add_argument("--outdir", default=str(Path(__file__).resolve().parent.parent / "output"))
    args = ap.parse_args()

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

    # A real product warms up its model before the audience arrives, not
    # during the performance -- the first MPS/CUDA call always eats a large,
    # one-off graph-compilation tax that has nothing to do with steady-state
    # inference speed. Soundcheck, not showtime.
    print("soundcheck: warming up the model (not part of the timed performance) ...")
    warm_start = time.monotonic()
    dummy = [t for onset, dur, pitch in melody[:6] for t in make_event(onset, dur, MELODY_INSTR, pitch)]
    generate_duet(model, melody[5][0] + melody[5][1], melody[5][0] + melody[5][1] + beat_s,
                  dummy, args.top_p, args.accomp_bias)
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
        accomp_bias=args.accomp_bias,
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
