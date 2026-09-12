import re

import pytest

from bench_harmony import ARPEGGIO, BEATS_PER_BAR, HALF_BAR, arpeggio_events, score
from brain import HarmonyBrain, sampling_for
from form import ENDING_SILENCE_BEATS


def replay(brain: HarmonyBrain, chords=ARPEGGIO):
    """Feed the bench's arpeggio (with detection latency) through the brain, one tick per half bar,
    and return chord events the way the service emits them: (chord_from, chord, '')."""
    events = arpeggio_events(chords)
    fed = 0
    out = []
    n_beats = len(chords) * BEATS_PER_BAR
    for tick in range(0, n_beats + 1, HALF_BAR):
        while fed < len(events) and events[fed][2] <= tick:
            midi, _onset, arrival = events[fed]
            brain.on_note(midi, arrival)
            fed += 1
        r = brain.on_tick(float(tick))
        out.append((r["chord_from"], _chord(r["chord"]), ""))
    return out


def _chord(name):
    from harmony import Chord, NAMES
    root, quality = re.match(r"^([A-G]#?)(m?)$", name).groups()
    return Chord(NAMES.index(root), "min" if quality else "maj")


class TestChordDecision:
    @pytest.mark.parametrize("lookahead", [0.0, 2.0, 4.0])
    def test_arpeggio_bar_start_accuracy_at_least_half(self, lookahead):
        brain = HarmonyBrain(key="A minor", lookahead_beats=lookahead)
        s = score(replay(brain), ARPEGGIO)
        assert s["bar_start"] >= 0.5, s["names"]

    def test_chord_from_is_the_window_start(self):
        brain = HarmonyBrain(key="A minor", lookahead_beats=4.0)
        r = brain.on_tick(6.0)
        assert r["chord_from"] == 10.0

    def test_no_key_falls_back_to_client_chord(self):
        brain = HarmonyBrain()
        brain.set_controls({"chord": "F"})
        assert brain.on_tick(0.0)["chord"] == "F"
        assert HarmonyBrain().on_tick(0.0)["chord"] is None


class TestClientChordOverride:
    def test_client_chord_wins_before_four_notes(self):
        brain = HarmonyBrain(key="A minor")
        brain.set_controls({"chord": "G"})
        for i in range(3):
            brain.on_note(57, float(i))
        assert brain.on_tick(4.0)["chord"] == "G"

    def test_service_decision_wins_from_four_notes(self):
        brain = HarmonyBrain(key="A minor", lookahead_beats=0.0)
        brain.set_controls({"chord": "G"})
        for i in range(4):
            brain.on_note(57, float(i))  # A sung four times: Am, whatever the client says
        assert brain.on_tick(2.0)["chord"] == "Am"

    def test_cleared_client_chord_yields_to_the_service(self):
        brain = HarmonyBrain(key="A minor")
        brain.set_controls({"chord": "G"})
        brain.set_controls({"chord": None})
        assert brain.on_tick(0.0)["chord"] != "G"


class TestSection:
    def test_intro_then_groove(self):
        brain = HarmonyBrain(key="A minor")
        sections = [brain.on_tick(float(b))["section"] for b in range(0, 16, 2)]
        assert sections[:4] == ["intro"] * 4
        assert sections[4:] == ["groove"] * 4

    def test_form_ticks_once_per_bar(self):
        brain = HarmonyBrain(key="A minor")
        brain.set_controls({"intensity": 0.9})
        for b in range(0, 8, 2):
            brain.on_tick(float(b))
        assert brain.form.high_streak == 2

    def test_lift_after_hysteresis(self):
        brain = HarmonyBrain(key="A minor")
        brain.set_controls({"intensity": 0.9})
        seen = [brain.on_tick(float(b))["section"] for b in range(0, 40, 2)]
        assert "lift" in seen and seen[-1] == "lift"

    def test_ending_then_ended_then_idle_until_notes(self):
        brain = HarmonyBrain(key="A minor")
        for b in range(0, 12, 2):
            brain.on_tick(float(b))
        brain.set_controls({"silenceBeats": ENDING_SILENCE_BEATS})
        r = brain.on_tick(12.0)
        assert r["section"] == "ending" and not r["idle"]
        r = brain.on_tick(16.0)
        assert r["section"] == "ended" and r["idle"]
        assert brain.on_tick(20.0)["idle"]
        brain.set_controls({"silenceBeats": 0})
        brain.on_note(57, 22.0)
        r = brain.on_tick(24.0)
        assert not r["idle"] and r["section"] == "groove"

    def test_reset_returns_to_intro(self):
        brain = HarmonyBrain(key="A minor")
        for b in range(0, 12, 2):
            brain.on_tick(float(b))
        brain.reset("A minor", "lofi")
        assert brain.on_tick(0.0)["section"] == "intro"
        assert brain.genre == "lofi"


class TestSamplingKnee:
    def test_linear_below_the_knee_matches_the_old_ramp(self):
        for c in (0.0, 0.3, 0.8):
            temp, top_p = sampling_for(c)
            assert temp == pytest.approx(0.9 + c * 0.4)
            assert top_p == pytest.approx(0.85 + c * 0.14)

    def test_wild_zone_reaches_further(self):
        assert sampling_for(1.0) == pytest.approx((1.5, 1.0))
        t9, p9 = sampling_for(0.9)
        assert 1.22 < t9 < 1.5 and 0.962 < p9 < 1.0
