"""The per-connection musical brain: chord decisions (harmony.py + predict.py) and song form
(form.py), driven by the client's notes, half-bar ticks and `set` messages.

Pure Python, no torch: server.py calls `on_note`, `on_tick` and `set_controls` and reads
the result off the plan. Steps 2 and 3 of docs/superpowers/specs/2026-09-12-one-brain-design.md.
"""
from __future__ import annotations

from typing import Optional

from form import SongForm
from harmony import Chord, Key, MelodyHarmonizer, chord_name, parse_key
from predict import (RECENT_HALF_BARS, HMM_WINDOW, decide, emission_vector, hmm_reading, predict_ahead_hmm,
                     predict_next, predict_next_hmm)

BEATS_PER_BAR = 4.0
HALF_BAR = 2.0
# Which next-chord predictor decide_chord uses: 'hmm' (learned Chordonomicon transitions +
# Viterbi, predict.predict_next_hmm) or 'table' (the hand-written first-order table). The
# table remains the default: HMM gains 12 points on the benchmark mean but loses
# one bar on the live replay and 12 points on the minor loop. Both remain testable
# explicitly, independently of the selected default.
PREDICTOR = 'hmm'  # owner decision 2026-09-13: use the Chordonomicon-fitted transitions (CC BY-NC; resolve before any paid tier)
# Below this many heard notes an old client's `set.chord` still names the chord; from here on
# the service's own decision wins.
CLIENT_CHORD_MAX_NOTES = 4
# The client's IDLE_DYNAMICS equivalents, used until the first `set` carries the fields.
DEFAULT_INTENSITY = 0.5
DEFAULT_SILENCE_BEATS = 0.0
# The browser's pitch detector reports a note this long after its onset, but the `notes`
# message carries the onset beat. The harmonizer is ticked this much behind the cue so a note
# weighs what it would had it been timestamped on arrival (bench_harmony.py replays the same).
DETECTION_LATENCY_S = 0.125
# Creativity knee (CREATIVITY_BENCH.md): linear ramp to 0.8, then the wild zone opens up.
CREATIVITY_KNEE = 0.8


def sampling_for(creativity: float) -> tuple[float, float]:
    """(temperature, top_p) for a creativity in [0, 1].

    Up to the knee the ramp is the old one (0.9..1.3 / 0.85..0.99 over 0..1, so 1.22 / 0.962 at
    0.8); above it temperature reaches 1.5 and top-p 1.0, mirroring the arrangement filter's
    own knee so the two knobs open up together.
    """
    c = max(0.0, min(1.0, float(creativity)))
    if c <= CREATIVITY_KNEE:
        return 0.9 + c * 0.4, 0.85 + c * 0.14
    t = (c - CREATIVITY_KNEE) / (1.0 - CREATIVITY_KNEE)
    temp0, top0 = 0.9 + CREATIVITY_KNEE * 0.4, 0.85 + CREATIVITY_KNEE * 0.14
    return temp0 + t * (1.5 - temp0), top0 + t * (1.0 - top0)


class HarmonyBrain:
    def __init__(self, key: Optional[str] = None, genre: Optional[str] = None,
                 lookahead_beats: float = 4.0, beats_per_bar: float = BEATS_PER_BAR, bpm: float = 90.0,
                 predictor: str = PREDICTOR):
        self.lookahead_beats = lookahead_beats
        self.beats_per_bar = beats_per_bar
        self.latency_beats = DETECTION_LATENCY_S * bpm / 60.0
        self.predictor = predictor
        self.reset(key, genre)

    def reset(self, key: Optional[str] = None, genre: Optional[str] = None) -> None:
        self.key_name = key
        self.genre = genre
        self.harmonizer = MelodyHarmonizer(window=HALF_BAR)
        self.recent_chords: list[Chord] = []
        self.recent_sources: list[str] = []
        self.emissions: list[list[float]] = []
        self.notes_heard = 0
        self.client_chord: Optional[str] = None
        self.chord: Optional[str] = None
        self.chord_from = 0.0
        self.form = SongForm()
        self.last_form_bar: Optional[int] = None
        self.section = "intro"
        self.intensity = DEFAULT_INTENSITY
        self.silence_beats = DEFAULT_SILENCE_BEATS

    # -- inputs -------------------------------------------------------------------------

    @property
    def key(self) -> Optional[Key]:
        return parse_key(self.key_name)

    def set_controls(self, msg: dict) -> None:
        if msg.get("key"):
            self.key_name = msg["key"]
        if "genre" in msg and msg["genre"]:
            self.genre = msg["genre"]
        if "chord" in msg:
            self.client_chord = msg["chord"] or None
        if msg.get("intensity") is not None:
            self.intensity = max(0.0, min(1.0, float(msg["intensity"])))
        if msg.get("silenceBeats") is not None:
            self.silence_beats = max(0.0, float(msg["silenceBeats"]))

    def on_note(self, pitch: int, beat: float) -> None:
        self.harmonizer.add_note(pitch, beat)
        self.notes_heard += 1
        if self.form.section in ("ending", "ended"):
            # The singer came back after the band stopped: a new song, from the intro.
            self.form.reset(start_bar=int(beat // self.beats_per_bar))
            self.last_form_bar = None
            self.section = "intro"

    # -- per-tick decision ----------------------------------------------------------------

    @property
    def idle(self) -> bool:
        """True once the form has ended: ticks get empty plans until notes or a start reset it."""
        return self.form.section == "ended"

    def on_bar(self, bar: int, intensity: Optional[float] = None, silence_beats: Optional[float] = None,
               player_stopped: bool = False) -> str:
        if intensity is not None:
            self.intensity = intensity
        if silence_beats is not None:
            self.silence_beats = silence_beats
        self.section = self.form.tick(bar, self.intensity, self.silence_beats, player_stopped)["section"]
        self.last_form_bar = bar
        return self.section

    def decide_chord(self, tick_beat: float) -> Optional[str]:
        """The chord for the plan window starting `lookahead_beats` past `tick_beat`."""
        key = self.key
        if key is None:
            return self.client_chord
        self.harmonizer.tick(tick_beat - self.latency_beats, key)
        reading = self.harmonizer.reading
        downbeat = tick_beat % self.beats_per_bar == 0
        self.emissions = (self.emissions + [emission_vector(reading, key)])[-HMM_WINDOW:]
        genre, recent, emissions = self.genre, self.recent_chords, self.emissions
        if self.predictor == 'hmm':
            if reading is not None:
                reading = hmm_reading(key, genre, reading, recent, emissions, downbeat=downbeat)
            chord, source = decide(key, genre, reading, recent, reading.coverage if reading else 0.0,
                                   downbeat=downbeat, sources=self.recent_sources,
                                   predictor=lambda rc: predict_next_hmm(key, genre, rc, emissions, downbeat=downbeat),
                                   predict_through_corrections=True)
        else:
            chord, source = decide(key, genre, reading, recent, reading.coverage if reading else 0.0,
                                   downbeat=downbeat, sources=self.recent_sources)
        self.recent_sources = (self.recent_sources + [source])[-RECENT_HALF_BARS:]
        self.recent_chords = (self.recent_chords + [chord])[-RECENT_HALF_BARS:]
        # The plan is committed `lookahead_beats` ahead: walk the prediction over every downbeat
        # between the tick and the window start, as bench_harmony.run does.
        downbeats_ahead = 0
        t = tick_beat
        while t + HALF_BAR <= tick_beat + self.lookahead_beats:
            t += HALF_BAR
            if t % self.beats_per_bar == 0:
                downbeats_ahead += 1
        target = chord
        if self.predictor == 'hmm':
            target = predict_ahead_hmm(key, genre, self.recent_chords, self.recent_sources, emissions,
                                       downbeat, chord, downbeats_ahead)
        else:
            for _ in range(downbeats_ahead):
                target = predict_next(key, [target], genre)
        own = chord_name(target)
        if self.client_chord and self.notes_heard < CLIENT_CHORD_MAX_NOTES:
            return self.client_chord
        return own

    def on_tick(self, tick_beat: float) -> dict:
        """Everything the plan for the cue at `tick_beat` needs: chord, chord_from, section."""
        bar = int(tick_beat // self.beats_per_bar)
        if self.last_form_bar is None or bar > self.last_form_bar:
            self.on_bar(bar)
        self.chord = self.decide_chord(tick_beat)
        self.chord_from = tick_beat + self.lookahead_beats
        return {"chord": self.chord, "chord_from": self.chord_from, "section": self.section, "idle": self.idle}
