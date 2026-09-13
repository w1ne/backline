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
import asyncio
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Optional

import torch
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
import uvicorn

# bench/amt/ lives two directories up from this file (repo_root/bench/amt),
# alongside services/amt/. Not a package -- add it to sys.path directly.
BENCH_AMT_DIR = Path(__file__).resolve().parent.parent.parent / "bench" / "amt"
sys.path.insert(0, str(BENCH_AMT_DIR))

from anticipation import ops  # noqa: E402
from anticipation.config import TIME_RESOLUTION  # noqa: E402
from anticipation.vocab import TIME_OFFSET, DUR_OFFSET, MAX_DUR  # noqa: E402

from amt import (  # noqa: E402
    MELODY_INSTR,
    ACCOMP_BIAS,
    make_event,
    parse_events,
    generate_duet,
)
from live_duet import AccompanimentCommitter  # noqa: E402
from arrangement import (  # noqa: E402
    Arranger, plan_window,
)
from cached import cached_generate  # noqa: E402
from brain import HarmonyBrain, sampling_for  # noqa: E402
from musical_identity import MusicalIdentity
from performance_history import PerformanceHistory  # noqa: E402
from instruments import resolve as resolve_instruments, resolve_groups, TOGGLEABLE_PRESETS, DEFAULT_PRESETS  # noqa: E402,F401
from priming import build_prompt  # noqa: E402
from readiness import health_response  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("amt-server")

PORT = int(os.environ.get("PORT", "8080"))
SAMPLER = os.environ.get("AMT_SAMPLER", "cached")
if SAMPLER == "cached":
    generate_duet = cached_generate

MODEL_NAME = os.environ.get("AMT_MODEL", "stanford-crfm/music-small-800k")
# The generation deadline is what is left of the lead time between the cue and the plan's first
# note once the client<->server hop (`tick.rttMs`, measured by the client; this default until it
# has) and a fixed margin for the client's own scheduling are taken off. It used to be a fixed
# 0.8 of the window, which at 120 bpm left 10 ms for the hop and at 140 bpm less than nothing.
DEFAULT_RTT_S = 0.25
DEADLINE_MARGIN_S = 0.15
DEADLINE_FLOOR_S = 0.1
# Beats of past music kept as context for the next window. generate_duet() prompts the model
# with the whole prior token stream, so an unpruned session makes every bar's prompt longer
# than the last and per-bar latency climbs linearly with the length of the take (measured in
# the browser: 121 ms at bar 1, 936 ms at bar 20, still rising). Four bars of melody plus the
# accompaniment already committed over them is more than the model needs to continue one bar.
CONTEXT_BEATS = 16.0
# Empty-window policy. Silence from a successful model call is normally a rest, but while the
# model has heard fewer than this many beats of the human (it has little to answer) or when the
# previous window was already empty (a dropout, not a rest), the window is filled with the
# key-only plan so the band never goes quiet for a whole bar.
FILL_UNTIL_HEARD_BEATS = 8.0
# Listen gate for a `start {resume: true}` (a client reconnecting mid-set), in beats.
RESUME_LISTEN_BEATS = 2.0

app = FastAPI()
inference_lock = asyncio.Lock()
_model = None
_device = None
_load_error = None
_load_task: Optional[asyncio.Task] = None


@app.get("/health")
async def health():
    # Readiness, not liveness: 503 `loading` until the model is in memory, 503 `error` if the
    # load failed, so the relay/watchdog/deploy can tell a slow pod from a broken one.
    code, body = health_response(_model is not None, _load_error, MODEL_NAME, _device, SAMPLER)
    return JSONResponse(body, status_code=code)


def load_model():
    global _model, _device, _load_error
    if _model is not None:
        return _model
    _device = "cuda" if torch.cuda.is_available() else "cpu"
    log.info("loading %s on %s ...", MODEL_NAME, _device)
    try:
        from transformers import AutoModelForCausalLM

        model = AutoModelForCausalLM.from_pretrained(MODEL_NAME).to(_device)
        model.eval()
    except Exception as error:
        _load_error = error
        log.exception("model load failed")
        raise
    _model = model
    _load_error = None
    log.info("model loaded")
    return _model


@app.on_event("startup")
async def load_model_at_start():
    """Load at process start, in a thread, so /health can answer 503 `loading` meanwhile and the
    first WebSocket no longer pays the ~4 s load under the inference lock."""
    global _load_task
    _load_task = asyncio.create_task(asyncio.to_thread(load_model))


async def model_ready():
    """The loaded model; awaits the startup load (or starts one when the app is run without it)."""
    global _load_task
    if _model is not None:
        return _model
    if _load_task is None or (_load_task.done() and _load_task.exception() is not None):
        _load_task = asyncio.create_task(asyncio.to_thread(load_model))
    return await asyncio.shield(_load_task)


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


BEATS_PER_BAR = 4.0
# Default beats between a cue and the start of the window it plans; the `start` message's
# `lookaheadBeats` overrides it per session (the browser sends 2 with half-bar commits).
PLAN_LOOKAHEAD_BEATS = 4.0


class Session:
    """Per-connection state: the human note history, plan history (token
    stream), and the AMT scheduler's lookahead/commit bookkeeping.

    Reuses bench/amt's event encoding and generate_duet() directly; the
    monophonic-per-instrument commit/trim logic is AccompanimentCommitter,
    imported unchanged from live_duet.py. The ensemble's different
    instruments are independent voices and may sound together -- only a
    single instrument overlapping itself gets trimmed -- and every
    committed note retains its GM identity and arranger-assigned output role.
    """

    def __init__(self, model):
        self.model = model
        self.reset(bpm=100.0, lookahead_beats=PLAN_LOOKAHEAD_BEATS, commit_beats=2.0, listen_beats=8.0, top_p=0.95)

    def reset(self, bpm, lookahead_beats, commit_beats, listen_beats, top_p,
              instrument_names=None, accomp_bias=ACCOMP_BIAS, key=None, genre=None):
        self.bpm = bpm
        self.beat_s = 60.0 / bpm
        self.lookahead_beats = lookahead_beats
        self.commit_beats = commit_beats
        self.listen_beats = listen_beats
        self.top_p = top_p
        self.creativity = .3
        self.amount = .5
        self.enabled_roles = {role: True for role in ("keys", "bass", "lead")}
        self.temperature = 1.02
        # Default to the validated string-ensemble preset rather than a lone violin: a single
        # instrument was consistently too sparse against a real, densely-played performance to be
        # heard at all (see bench/amt/SETUP.md in the Music repo this was ported from). Every
        # selected instrument is an independent voice that may overlap the others --
        # AccompanimentCommitter below only keeps each individual instrument monophonic -- and
        # each retains its GM instrument identity and musical output role.
        self.instrument_names = list(DEFAULT_PRESETS if instrument_names is None else instrument_names)
        self.accomp_instrs = resolve_instruments(self.instrument_names)
        self.accomp_bias = accomp_bias

        self.history: list[int] = []
        self.committer = AccompanimentCommitter(self.history)
        self.committed_horizon_beats = 0.0
        self.last_accomp_notes: list[tuple[float, float, int]] = []
        self.key = key
        self.genre = genre
        # The chord the model's window is voiced against: decided by the brain on every tick
        # (an old client's `set.chord` only until four human notes have been heard).
        self.chord = None
        self.section = "intro"
        self.space = False
        # Empty-window policy state: onset of the first human note heard, and how many windows
        # in a row the model has returned nothing for.
        self.first_human_beat = None
        self.empty_windows = 0
        self.brain = HarmonyBrain(key=key, genre=genre, lookahead_beats=lookahead_beats, bpm=bpm)
        self.performance = PerformanceHistory(self.history, make_event, MELODY_INSTR, self.beat_s, self.brain.on_note)
        self.human_notes = self.performance.notes
        self.identity = MusicalIdentity()
        self.phrase_response = False
        self.phrase_responses = False

    def set_controls(self, msg):
        if 'phraseResponses' in msg:
            self.phrase_responses = msg['phraseResponses'] is True
        self.key = msg.get("key", self.key)
        self.brain.set_controls(msg)
        self.space = bool(msg.get("space", self.space))
        self.creativity = max(0.0, min(1.0, float(msg.get("creativity", self.creativity))))
        self.temperature, self.top_p = sampling_for(self.creativity)
        self.amount = max(0.0, min(1.0, float(msg.get("amount", self.amount))))
        if isinstance(msg.get("enabledRoles"), dict):
            self.enabled_roles.update({role: bool(value) for role, value in msg["enabledRoles"].items()
                                       if role in self.enabled_roles})
        if "accompInstruments" in msg:
            self.instrument_names = list(msg["accompInstruments"] or [])
            self.accomp_instrs = resolve_instruments(self.instrument_names)
        if "accompBias" in msg:
            self.accomp_bias = float(msg["accompBias"])

    def set_bpm(self, bpm):
        """A tempo change mid-session. Everything the session reasons about is in beats (the
        human notes, the commit horizon, the listen gate, the brain); only the model's token
        stream and the committer's trim state are in seconds, so those are rescaled in place and
        the session carries on. It used to take a reconnect: a new socket, an empty history and
        the eight-beat listen gate again, for every two-bpm step of a singer's drift."""
        try:
            bpm = float(bpm)
        except (TypeError, ValueError):
            return
        if not (0 < bpm < 1000) or bpm == self.bpm:
            return
        ratio = self.bpm / bpm  # old beat_s -> new beat_s
        self.bpm = bpm
        self.beat_s = 60.0 / bpm
        self.performance.beat_seconds = self.beat_s
        self.brain.latency_beats *= 1.0 / ratio
        for i in range(0, len(self.history) - 2, 3):
            self.history[i] = TIME_OFFSET + max(0, round((self.history[i] - TIME_OFFSET) * ratio))
            self.history[i + 1] = DUR_OFFSET + min(MAX_DUR - 1, max(1, round((self.history[i + 1] - DUR_OFFSET) * ratio)))
        for table in ("_last_end", "_prev_onset"):
            seconds = getattr(self.committer, table, None)
            if isinstance(seconds, dict):
                for instr in seconds:
                    seconds[instr] *= ratio
        self.last_accomp_notes = [(t * ratio, d * ratio, p) for (t, d, p) in self.last_accomp_notes]

    @property
    def arranger(self):
        return Arranger(self.amount, self.creativity, self.enabled_roles, self.section)

    def add_human_notes(self, notes):
        ended = self.brain.form.section in ('ending', 'ended')
        self.performance.add(notes)
        if ended and self.brain.form.section == 'intro':
            self.identity.reset()
        if self.first_human_beat is None and self.human_notes:
            self.first_human_beat = min(onset for (onset, _, _) in self.human_notes)

    def update_human_notes(self, notes):
        self.performance.update(notes)

    def prune_context(self, start_beat: float) -> int:
        """Drop events that start more than CONTEXT_BEATS before `start_beat` from the token
        history, and return how many tokens went.

        History is a flat stream of (time, duration, note) triples appended in arrival order,
        which is time-ordered to within one bar (accompaniment for the next bar is committed
        while the melody of the current one is still coming in). Deleting the longest prefix
        whose onsets are all older than the cutoff therefore keeps at most one extra bar --
        near enough. Active notes removed with that prefix are carried forward as
        clipped context events while their original captured onset remains intact.
        """
        cutoff_beat = start_beat - CONTEXT_BEATS
        if cutoff_beat <= 0:
            return 0
        cutoff_token = TIME_OFFSET + max(0, round(cutoff_beat * self.beat_s * TIME_RESOLUTION))
        n = 0
        while n < len(self.history) and self.history[n] < cutoff_token:
            n += 3
        if n == 0:
            return 0
        del self.history[:n]
        self.committer.drop_prefix(n)
        self.performance.drop_prefix(n, cutoff_beat)
        return n

    def generate_next_bar_plan(self, bar: int) -> dict:
        """An old client's `bar` cue: the plan for the whole of bar `bar + 1`."""
        return self.generate_plan(bar * BEATS_PER_BAR, BEATS_PER_BAR, label=f"bar {bar}")

    def generate_tick_plan(self, beat: float, rtt_ms=None) -> dict:
        """A `tick` cue at `beat` (every `commit_beats`): the plan for the half bar one bar ahead.
        `rtt_ms` is the client's last measured cue-to-plan hop, if it has one."""
        return self.generate_plan(beat, self.commit_beats, label=f"tick {beat:g}", rtt_ms=rtt_ms)

    def generate_plan(self, now_beat: float, span_beats: float, label: str = "", rtt_ms=None) -> dict:
        """Generate the accompaniment plan for the `span_beats` window starting
        `self.lookahead_beats` past the cue at `now_beat` (4/4 assumed -- matches
        the app's Players.schedule bar granularity).

        The window is anchored to the cue that just happened. It used to start
        at a horizon that only crept forward by `commit_beats` per `bar`
        message: a bar is four beats but only two were ever committed, so the
        plan slipped two beats further into the past every bar (by bar 7 it
        was writing beat 14 while the player was at beat 32) and the model's
        sampling budget was spread over an ever-widening generate span while
        the kept window stayed two beats -- which is why most bars came back
        with no notes at all.
        """
        target_start_beat, target_end_beat = plan_window(now_beat, span_beats, self.lookahead_beats)
        self.phrase_response = False
        self.performance.observe_through(now_beat)
        self.identity.observe(self.human_notes, self.performance.records, now_beat)
        self.prune_context(target_start_beat)
        # Chord and section for this window: harmony.py/predict.py and form.py via the brain.
        brain_out = self.brain.on_tick(now_beat)
        self.chord = brain_out["chord"]
        self.section = brain_out["section"]
        arranger = self.arranger
        generation_instrs = arranger.generation_instruments(self.accomp_instrs)
        if brain_out["idle"] or not generation_instrs:
            # Silence is explicit when the form ends or no instruments are enabled.
            log.info("%s: idle or muted, empty plan", label)
            return {
                "plan": self.plan_message(target_start_beat, target_end_beat, []),
                "status": {"type": "status", "latencyMs": 0.0, "tokensPerSec": 0.0},
            }

        # Listen-first (ReaLJam): commit nothing until `listen_beats` of the
        # player's melody have been heard, so the model answers real material
        # instead of guessing from a nearly empty bar. This was parsed from
        # the `start` message and then never used.
        if not self.human_notes or target_end_beat <= self.listen_beats:
            log.info("%s: listening (target window ends at beat %.1f, listen=%.1f)",
                     label, target_end_beat, self.listen_beats)
            return {
                "plan": self.plan_message(
                    target_start_beat, target_end_beat,
                    []),
                "status": {"type": "status", "latencyMs": 0.0, "tokensPerSec": 0.0},
            }

        # Never re-commit music already frozen, never fall behind the live bar.
        start_beat = max(target_start_beat, self.committed_horizon_beats, self.listen_beats)
        commit_end_beat = max(target_end_beat, start_beat + self.commit_beats)
        # Generate at least `lookahead_beats`; anything past the commit point is
        # discarded and rewritten next bar with fresher melody.
        end_beat = max(commit_end_beat, start_beat + self.lookahead_beats)

        start_s = start_beat * self.beat_s
        end_s = end_beat * self.beat_s
        commit_end_s = commit_end_beat * self.beat_s

        history_before = list(self.history)
        human_in_context = sum(1 for (onset_beat, _, _) in self.human_notes if onset_beat <= start_beat)
        # Tempo-aware deadline: the plan is due at `start_beat`, so spend what is left of the lead
        # time after the hop back to the client and its scheduling margin. The next cue arrives
        # after `span_beats`, so the lead time is also capped at the window's own length to keep
        # the queue from falling behind the cues.
        try:
            rtt_s = float(rtt_ms) / 1000.0 if rtt_ms is not None else DEFAULT_RTT_S
        except (TypeError, ValueError):
            rtt_s = DEFAULT_RTT_S
        if not (0.0 <= rtt_s < 60.0):
            rtt_s = DEFAULT_RTT_S
        lead_s = min(start_beat - now_beat, commit_end_beat - start_beat) * self.beat_s
        deadline_s = max(DEADLINE_FLOOR_S, lead_s - rtt_s - DEADLINE_MARGIN_S)
        # One sampling pass per selected preset, each masked to that preset's instruments
        # and prompted with the same history. A single pass over the union locks onto the
        # first instrument it happens to write (the history then keeps telling it "this is
        # a cello line"), so any other tile the player switched on never joins.
        groups = [g for g in (tuple(p for p in group if p in generation_instrs)
                              for group in resolve_groups(self.instrument_names)) if g]
        pass_deadline_s = deadline_s / max(1, len(groups))
        start_tick = round(start_s * TIME_RESOLUTION)
        commit_end_tick = round(commit_end_s * TIME_RESOLUTION)
        t0 = time.monotonic()
        accomp = []
        tokens_generated = 0
        result = []
        for group in groups:
            # Style prime + chord pad live only in the prompt (see priming.py); the
            # prime moves the live timeline later by `shift_s`.
            prompt, shift_s = build_prompt(history_before, group, self.key, self.genre, self.chord,
                                           start_s, end_s, self.beat_s)
            result = generate_duet(
                self.model, start_s + shift_s, end_s + shift_s, prompt, group, self.top_p, self.accomp_bias,
                temperature=self.temperature,
                deadline_s=pass_deadline_s,
                # The committed voice is monophonic and the app plays to a beat grid, so a
                # sixteenth note is the shortest onset gap worth sampling.
                min_interval_ticks=max(1, round(self.beat_s / 4.0 * TIME_RESOLUTION)),
            )
            if SAMPLER == "cached":
                tokens_generated += getattr(self.model, "amt_sampled_tokens", 0)
            accomp.extend((t - shift_s, d, instr, p) for (t, d, instr, p) in parse_events(result) if instr in group)
        latency_ms = (time.monotonic() - t0) * 1000.0

        # Compare on the model's own tick grid: the window bounds are bar lines
        # here, and a float `start_s < t` comparison dropped any note landing
        # exactly on one.
        raw_notes = [
            (t, d, instr, p) for (t, d, instr, p) in accomp
            if start_tick <= round(t * TIME_RESOLUTION) < commit_end_tick
        ]
        # Older open clients cannot cancel a queued answer when the player resumes.
        # They retain normal AMT backing and section contrast until refreshed.
        if self.phrase_responses:
            raw_notes = self.identity.shape(raw_notes, start_beat, commit_end_beat, self.beat_s,
                                            now_beat, self.creativity, self.section)
            self.phrase_response = self.identity.response_applied
        raw_notes = arranger.constrain(raw_notes, start_s, commit_end_s, self.beat_s,
                                       self.space, TIME_RESOLUTION, self.key, self.chord,
                                       phrase_instrument=self.identity.response_instrument if self.phrase_response else None)
        # (onset_s, dur_s, instr, pitch), trimmed/monophonic per instrument by the committer.
        committed = self.committer.commit(raw_notes)
        self.committed_horizon_beats = commit_end_beat
        self.last_accomp_notes = [(t, d, p) for (t, d, _, p) in committed]

        log.info(
            "%s: window [%.1f..%.1f) beats (generate to %.1f), human events in context=%d, "
            "context tokens=%d, accompaniment generated=%d, in window=%d, committed=%d, %.0f ms%s",
            label, start_beat, commit_end_beat, end_beat, human_in_context,
            len(history_before), len(accomp), len(raw_notes), len(committed), latency_ms,
            " (hit generation budget)" if latency_ms >= deadline_s * 1000.0 else "",
        )

        # The arranger routes the model's actual notes. A single empty window after the model
        # has heard enough of the human is a rest; before that, or twice in a row, it is filled
        # with the key-only plan (see FILL_UNTIL_HEARD_BEATS).
        if committed:
            self.empty_windows = 0
            notes_out = arranger.events(committed, self.beat_s, self.space)
        else:
            self.empty_windows += 1
            heard_beats = now_beat - self.first_human_beat if self.first_human_beat is not None else 0.0
            if heard_beats < FILL_UNTIL_HEARD_BEATS or self.empty_windows >= 2:
                notes_out = arranger.failure_fallback(self.key, self.chord, start_beat, commit_end_beat, self.beat_s)
                log.info("%s: empty window filled with key-only plan (%d notes; heard %.1f beats, %d empty in a row)",
                         label, len(notes_out), heard_beats, self.empty_windows)
            else:
                notes_out = []

        prior_clipped = ops.pad(
            ops.clip(history_before, 0, int(TIME_RESOLUTION * start_s), clip_duration=False, seconds=False),
            int(TIME_RESOLUTION * start_s),
        )
        if SAMPLER != "cached":
            tokens_generated = max(0, len(result) - len(prior_clipped))
        tokens_per_sec = (tokens_generated / (latency_ms / 1000.0)) if latency_ms > 0 else 0.0

        return {
            "plan": self.plan_message(start_beat, commit_end_beat, notes_out),
            "status": {"type": "status", "latencyMs": latency_ms, "tokensPerSec": tokens_per_sec},
        }

    def plan_message(self, from_beat: float, to_beat: float, notes: list) -> dict:
        """A plan with the chord in force from the window start and the current section.
        `chord`/`chordFrom`/`section` are optional: an old client ignores them."""
        plan = {"type": "plan", "fromBeat": from_beat, "toBeat": to_beat, "notes": notes, "section": self.section}
        if self.phrase_response and any(n.get("gmInstr") == self.identity.response_instrument for n in notes):
            plan["phraseResponse"] = True
            plan["phraseInstrument"] = self.identity.response_instrument
            plan["phraseFromBeat"] = from_beat
            plan["phraseToBeat"] = min(to_beat, from_beat + 2.)
        if self.chord:
            plan["chord"] = self.chord
            plan["chordFrom"] = from_beat
        return plan


def apply_session_message(session, msg):
    kind = msg.get("type")
    if kind == "start":
        # A client resuming after a dropped socket has already been heard for a while: two
        # beats of listening is enough to re-anchor, eight would be another two bars of silence.
        listen_beats = RESUME_LISTEN_BEATS if msg.get("resume") is True else float(msg.get("listenBeats", 8.0))
        session.reset(
            bpm=float(msg.get("bpm", 100.0)),
            lookahead_beats=float(msg.get("lookaheadBeats", PLAN_LOOKAHEAD_BEATS)),
            commit_beats=float(msg.get("commitBeats", 2.0)),
            listen_beats=listen_beats,
            top_p=0.95, instrument_names=msg.get("accompInstruments"),
            accomp_bias=float(msg.get("accompBias", ACCOMP_BIAS)),
            key=msg.get("key"), genre=msg.get("genre"),
        )
        session.set_controls(msg)
    elif kind == "notes":
        session.add_human_notes(msg.get("notes", []))
    elif kind == "note_updates":
        session.update_human_notes(msg.get("notes", []))
    elif kind == "set":
        if "bpm" in msg:
            session.set_bpm(msg["bpm"])
        session.set_controls(msg)


def generate_session_plan(session, msg):
    if msg["type"] == "bar":
        return session.generate_next_bar_plan(int(msg.get("bar", 0)))
    return session.generate_tick_plan(float(msg.get("beat", 0.0)), rtt_ms=msg.get("rttMs"))


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    from live_session import LatestPlanner, InputOverflow

    await websocket.accept()
    try:
        model = await model_ready()
    except Exception as error:
        await websocket.send_text(json.dumps({"type": "error", "message": f"model not ready: {error}"}))
        await websocket.close(code=1013)
        return
    send_lock = asyncio.Lock()

    async def send(msg):
        async with send_lock:
            await websocket.send_text(json.dumps(msg))

    async def emit(out, commit_if_current):
        async with send_lock:
            if not commit_if_current():
                return
            if "error" in out:
                await websocket.send_text(json.dumps({"type": "error", "message": out["error"]}))
            else:
                await websocket.send_text(json.dumps(out["plan"]))
                await websocket.send_text(json.dumps(out["status"]))

    planner = LatestPlanner(Session(model), inference_lock, apply_session_message, generate_session_plan, emit)
    log.info("connection opened")
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
                if not isinstance(msg, dict):
                    raise ValueError("expected a JSON object")
                kind = msg.get("type")
                if kind == "ping":
                    await send({"type": "pong"})
                elif kind in ("start", "notes", "note_updates", "bar", "tick", "set"):
                    planner.submit(msg)
                    if kind == "start":
                        await send({"type": "ready", "tick": True, "performanceEvents": True, "setBpm": True})
                else:
                    await send({"type": "error", "message": f"unknown type {kind}"})
            except InputOverflow as error:
                await send({"type": "error", "message": str(error)})
                await websocket.close(code=1009)
                break
            except (ValueError, TypeError) as error:
                await send({"type": "error", "message": str(error)})
    except WebSocketDisconnect:
        log.info("connection closed")
    finally:
        await planner.close()


def run_bench(n_bars=16):
    """--bench: simulate a 100 BPM melody from bench/amt/melody.py for
    `n_bars` bars and print per-bar generation ms and beats-of-accompaniment
    per second on this machine. Long runs are the ones worth watching: the
    number to check is that per-bar latency stays flat rather than climbing
    with the length of the take."""
    from melody import make_synthetic_melody

    model = load_model()
    bpm = 100.0
    beat_s = 60.0 / bpm
    beats_per_bar = 4.0
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
            f"context={len(session.history)}, "
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
    ap.add_argument("--bench", action="store_true", help="run the bench and exit")
    ap.add_argument("--bars", type=int, default=16, help="bars to simulate with --bench")
    args = ap.parse_args()

    if args.bench:
        run_bench(args.bars)
        return

    uvicorn.run(app, host="0.0.0.0", port=PORT)


if __name__ == "__main__":
    main()
