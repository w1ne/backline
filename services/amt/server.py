"""AMT (Anticipatory Music Transformer) note-following accompaniment service
for Backline.

Loads `stanford-crfm/music-small-800k` once at process start and serves a
per-connection lookahead/commit scheduler over a WebSocket. Unlike the
`bench/amt/live_duet.py` proof of concept -- which drives its own synthetic
melody on a wall-clock transport -- this service is *driven by the client*:
the browser sends the human's real notes as they arrive and a `bar` message
each time a new bar starts, and the server replies with the accompaniment
plan for the *next* bar. The scheduling core (instrument masking, generation,
monophonic commit/trim) is imported unchanged from `bench/amt/`.

No `from __future__ import annotations` here -- see services/acestep/server.py's
DEPLOYED.md note: it turns the `websocket: WebSocket` type hint into a string
at runtime (PEP 563), which stops FastAPI from recognizing the WebSocket
route parameter and every connection is rejected with a bare 403.

Env vars:
  PORT -- listen port (default 8080)
"""

import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Optional

import torch
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
import uvicorn

# bench/amt/ lives two directories up from this file (repo_root/bench/amt),
# alongside services/amt/. Not a package -- add it to sys.path directly.
BENCH_AMT_DIR = Path(__file__).resolve().parent.parent.parent / "bench" / "amt"
sys.path.insert(0, str(BENCH_AMT_DIR))

from anticipation import ops  # noqa: E402
from anticipation.config import TIME_RESOLUTION  # noqa: E402

from amt import (  # noqa: E402
    MELODY_INSTR,
    ACCOMP_INSTR,
    ACCOMP_BIAS,
    make_event,
    parse_events,
    generate_duet,
)
from live_duet import AccompanimentCommitter  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("amt-server")

PORT = int(os.environ.get("PORT", "8080"))
MODEL_NAME = "stanford-crfm/music-small-800k"

app = FastAPI()
_model = None
_device = None


def load_model():
    global _model, _device
    if _model is not None:
        return _model
    _device = "cuda" if torch.cuda.is_available() else "cpu"
    log.info("loading %s on %s ...", MODEL_NAME, _device)
    from transformers import AutoModelForCausalLM

    _model = AutoModelForCausalLM.from_pretrained(MODEL_NAME).to(_device)
    _model.eval()
    log.info("model loaded")
    return _model


class ChordInference:
    """Infers the bass note (chord root, one octave down) for a window of
    committed accompaniment notes -- a simple pitch-class mode within the
    window, since this PoC has no explicit chord/harmony model."""

    @staticmethod
    def root_below(notes: list[tuple[float, float, int]]) -> Optional[int]:
        if not notes:
            return None
        from collections import Counter

        pitch_classes = Counter(pitch % 12 for (_, _, pitch) in notes)
        root_pc = pitch_classes.most_common(1)[0][0]
        # Anchor to an octave clearly below the accompaniment register.
        lowest = min(pitch for (_, _, pitch) in notes)
        root = lowest - ((lowest - root_pc) % 12) - 12
        return max(0, root)


class Session:
    """Per-connection state: the human note history, plan history (token
    stream), and the AMT scheduler's lookahead/commit bookkeeping.

    Reuses bench/amt's event encoding and generate_duet() directly; the
    monophonic commit/trim logic is AccompanimentCommitter, unchanged from
    live_duet.py.
    """

    def __init__(self, model):
        self.model = model
        self.reset(bpm=100.0, lookahead_beats=4.0, commit_beats=2.0, listen_beats=8.0, top_p=0.95)

    def reset(self, bpm, lookahead_beats, commit_beats, listen_beats, top_p):
        self.bpm = bpm
        self.beat_s = 60.0 / bpm
        self.lookahead_beats = lookahead_beats
        self.commit_beats = commit_beats
        self.listen_beats = listen_beats
        self.top_p = top_p

        self.history: list[int] = []
        self.committer = AccompanimentCommitter(self.history)
        self.human_notes: list[tuple[float, float, int]] = []  # (onset_beat, dur_beat, pitch)
        self.committed_horizon_beats = 0.0
        self.last_accomp_notes: list[tuple[float, float, int]] = []

    def add_human_notes(self, notes):
        for n in notes:
            onset_beat = float(n["beat"])
            dur_beat = float(n.get("dur", 0.5))
            pitch = int(n["pitch"])
            self.human_notes.append((onset_beat, dur_beat, pitch))
            self.history.extend(
                make_event(onset_beat * self.beat_s, dur_beat * self.beat_s, MELODY_INSTR, pitch)
            )

    def generate_next_bar_plan(self, bar: int) -> dict:
        """Generate the accompaniment plan covering bar `bar + 1` (4 beats,
        4/4 assumed -- matches the app's Players.schedule bar granularity)."""
        start_beat = self.committed_horizon_beats
        beats_per_bar = 4.0
        target_end_beat = (bar + 2) * beats_per_bar  # end of the *next* bar
        end_beat = max(target_end_beat, start_beat + self.lookahead_beats)

        start_s = start_beat * self.beat_s
        end_s = end_beat * self.beat_s

        history_before = list(self.history)
        t0 = time.monotonic()
        result = generate_duet(self.model, start_s, end_s, history_before, self.top_p, ACCOMP_BIAS)
        latency_ms = (time.monotonic() - t0) * 1000.0

        commit_end_beat = start_beat + self.commit_beats
        commit_end_s = commit_end_beat * self.beat_s

        raw_notes = [
            (t, d, p)
            for (t, d, instr, p) in parse_events(result)
            if instr == ACCOMP_INSTR and start_s < t <= commit_end_s
        ]
        committed = self.committer.commit(raw_notes)  # (onset_s, dur_s, pitch), trimmed/monophonic
        self.committed_horizon_beats = commit_end_beat
        self.last_accomp_notes = committed

        notes_out = []
        for onset_s, dur_s, pitch in committed:
            notes_out.append(
                {
                    "beat": onset_s / self.beat_s,
                    "pitch": pitch,
                    "dur": dur_s / self.beat_s,
                    "vel": 0.85,
                    "voice": "keys",
                }
            )

        root = ChordInference.root_below([(o, d, p) for o, d, p in committed])
        if root is not None and committed:
            # One held bass note per bar, an octave below the inferred root,
            # starting at the same commit window as the keys voice above.
            notes_out.append(
                {
                    "beat": start_beat,
                    "pitch": root,
                    "dur": self.commit_beats,
                    "vel": 0.75,
                    "voice": "bass",
                }
            )

        prior_clipped = ops.pad(
            ops.clip(history_before, 0, int(TIME_RESOLUTION * start_s), clip_duration=False, seconds=False),
            int(TIME_RESOLUTION * start_s),
        )
        tokens_generated = max(0, len(result) - len(prior_clipped))
        tokens_per_sec = (tokens_generated / (latency_ms / 1000.0)) if latency_ms > 0 else 0.0

        return {
            "plan": {"type": "plan", "fromBeat": start_beat, "notes": notes_out},
            "status": {"type": "status", "latencyMs": latency_ms, "tokensPerSec": tokens_per_sec},
        }


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    model = load_model()
    session = Session(model)
    log.info("connection opened")
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_text(json.dumps({"type": "error", "message": "invalid JSON"}))
                continue

            mtype = msg.get("type")
            try:
                if mtype == "ping":
                    await websocket.send_text(json.dumps({"type": "pong"}))

                elif mtype == "start":
                    session.reset(
                        bpm=float(msg.get("bpm", 100.0)),
                        lookahead_beats=float(msg.get("lookaheadBeats", 4.0)),
                        commit_beats=float(msg.get("commitBeats", 2.0)),
                        listen_beats=float(msg.get("listenBeats", 8.0)),
                        top_p=0.95,
                    )

                elif mtype == "notes":
                    session.add_human_notes(msg.get("notes", []))

                elif mtype == "bar":
                    bar = int(msg.get("bar", 0))
                    out = session.generate_next_bar_plan(bar)
                    await websocket.send_text(json.dumps(out["plan"]))
                    await websocket.send_text(json.dumps(out["status"]))

                elif mtype == "set":
                    # genre/creativity/instruments have no effect on this PoC's
                    # generation path yet -- acknowledged but not applied.
                    pass

                else:
                    await websocket.send_text(json.dumps({"type": "error", "message": f"unknown type {mtype}"}))
            except Exception as e:  # noqa: BLE001
                log.exception("error handling message %s", mtype)
                await websocket.send_text(json.dumps({"type": "error", "message": str(e)}))
    except WebSocketDisconnect:
        log.info("connection closed")


def run_bench():
    """--bench: simulate a 100 BPM melody from bench/amt/melody.py for 16
    bars and print per-bar generation ms and beats-of-accompaniment per
    second on this machine."""
    from melody import make_synthetic_melody

    model = load_model()
    bpm = 100.0
    beat_s = 60.0 / bpm
    beats_per_bar = 4.0
    n_bars = 16
    n_notes = n_bars * 4  # ~1 note/beat

    melody, melody_len_s = make_synthetic_melody(key="C", mode="major", n_notes=n_notes, beat_s=beat_s, seed=0)

    session = Session(model)
    session.reset(bpm=bpm, lookahead_beats=4.0, commit_beats=2.0, listen_beats=8.0, top_p=0.95)

    # Warm up: exclude first-call graph/JIT overhead from the timed numbers.
    log.info("bench: warming up ...")
    warm = Session(model)
    warm.add_human_notes([{"beat": 0, "dur": 1.0, "pitch": 60}])
    warm.generate_next_bar_plan(0)

    print(f"--bench: 100 BPM, {n_bars} bars, device={_device}")
    total_wall_s = 0.0
    total_beats_committed = 0.0
    for bar in range(n_bars):
        bar_start_beat = bar * beats_per_bar
        bar_end_beat = bar_start_beat + beats_per_bar
        notes_in_bar = [
            {"beat": onset_s / beat_s, "dur": dur_s / beat_s, "pitch": pitch}
            for (onset_s, dur_s, pitch) in melody
            if bar_start_beat <= onset_s / beat_s < bar_end_beat
        ]
        session.add_human_notes(notes_in_bar)

        t0 = time.monotonic()
        out = session.generate_next_bar_plan(bar)
        wall_s = time.monotonic() - t0
        total_wall_s += wall_s

        committed_beats = session.commit_beats
        total_beats_committed += committed_beats
        print(
            f"bar {bar:2d}: generation {wall_s * 1000:7.1f} ms, "
            f"latencyMs={out['status']['latencyMs']:.1f}, "
            f"tokensPerSec={out['status']['tokensPerSec']:.1f}, "
            f"notes={len(out['plan']['notes'])}"
        )

    rate = total_beats_committed / total_wall_s if total_wall_s > 0 else 0.0
    print(
        f"--bench summary: {n_bars} bars, total wall {total_wall_s:.2f}s, "
        f"{total_beats_committed:.1f} beats of accompaniment committed, "
        f"{rate:.2f} beats-of-accompaniment/sec on this machine"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bench", action="store_true", help="run the 16-bar bench and exit")
    args = ap.parse_args()

    if args.bench:
        run_bench()
        return

    uvicorn.run(app, host="0.0.0.0", port=PORT)


if __name__ == "__main__":
    main()
