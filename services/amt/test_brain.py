import re

import pytest

from bench_harmony import ARPEGGIO, BEATS_PER_BAR, BPM, HALF_BAR, arpeggio_events, run, score
from brain import PREDICTOR, HarmonyBrain, sampling_for
from harmony import chord_name
from form import ENDING_SILENCE_BEATS


def replay(brain: HarmonyBrain, chords=ARPEGGIO):
    """Feed the bench's arpeggio through the brain the way the client does -- the note arrives
    after the detection latency but is timestamped with its onset beat -- one tick per half bar,
    and return chord events the way the service emits them: (chord_from, chord, '')."""
    events = arpeggio_events(chords)
    fed = 0
    out = []
    n_beats = len(chords) * BEATS_PER_BAR
    for tick in range(0, n_beats + 1, HALF_BAR):
        while fed < len(events) and events[fed][2] <= tick:
            midi, onset, _arrival = events[fed]
            brain.on_note(midi, onset)
            fed += 1
        r = brain.on_tick(float(tick))
        out.append((r["chord_from"], _chord(r["chord"]), ""))
    return out


def _chord(name):
    from harmony import Chord, NAMES
    root, quality = re.match(r"^([A-G]#?)(m?)$", name).groups()
    return Chord(NAMES.index(root), "min" if quality else "maj")


def live_replay(lookahead, bars=16, genre="lofi", client_chord="Am", predictor=PREDICTOR):
    """The message sequence bench/streammuse/tools/tick_latency.mjs sends for the `arpeggio`
    clip, as server.py hands it to the brain: `start` (key, genre, lookaheadBeats), `set`
    (chord Am), every note as a `notes` message carrying its onset beat but arriving
    DETECTION_LATENCY_S later, and a `tick` every two beats. Returns the tool's own
    "chord at bar start" line (latest plan whose chordFrom <= bar start; Am before any)."""
    brain = HarmonyBrain(key="A minor", genre=genre, lookahead_beats=lookahead, bpm=BPM, predictor=predictor)
    brain.set_controls({"key": "A minor", "chord": client_chord, "creativity": 0.3})
    events = arpeggio_events(ARPEGGIO * (bars // len(ARPEGGIO)))
    fed = 0
    plans = []
    for tick in range(0, bars * BEATS_PER_BAR, HALF_BAR):
        while fed < len(events) and events[fed][2] <= tick:
            midi, onset, _arrival = events[fed]
            brain.on_note(midi, onset)
            fed += 1
        r = brain.on_tick(float(tick))
        plans.append((r["chord_from"], r["chord"]))
    at_start = []
    for bar in range(bars):
        chord = "Am"
        for chord_from, name in plans:
            if name and chord_from <= bar * BEATS_PER_BAR + 0.01:
                chord = name
        at_start.append(chord)
    return at_start


class TestLiveReplay:
    """What the relay run scores must be what the brain scores on the same messages."""

    def test_arpeggio_live_sequence_lookahead_2_table(self):
        """The relay run that produced this line ran the table predictor."""
        truth = [chord_name(c) for c in ARPEGGIO] * 2
        at_start = live_replay(2.0, predictor="table")
        hits = sum(a == t for a, t in zip(at_start, truth))
        assert at_start[:8] == ["Am", "Am", "G", "F", "Am", "F", "Em", "Am"], at_start
        assert hits / len(truth) >= 0.5, (hits, at_start)

    def test_arpeggio_live_sequence_lookahead_2_hmm(self):
        """The HMM predictor on the same messages. Bar 1 is the client chord for both
        predictors; the hmm lands F C G on bars 2-4 where the table lands G F Am, and loses bars 6-7
        to the corpus preferring i -> VI and (i, iv) -> i over this clip's Dm and Em. 7/16 here
        against the table's 8/16; HARMONY_BENCH.md has it ahead at every lookahead on average."""
        truth = [chord_name(c) for c in ARPEGGIO] * 2
        at_start = live_replay(2.0, predictor="hmm")
        assert at_start[:8] == ["Am", "Am", "C", "G", "Am", "F", "Am", "G"], at_start
        assert sum(a == t for a, t in zip(at_start, truth)) == 7, at_start

    def test_lookahead_4_is_the_relay_run_before_the_fix(self):
        """server.py planned one bar ahead whatever `lookaheadBeats` said; this is the line the
        relay reported at both settings (3/8), so the bug was the server, not the brain."""
        assert live_replay(4.0, predictor="table")[:8] == ["Am", "Am", "G", "Am", "Am", "Am", "G", "Am"]

    def test_lookahead_4_hmm(self):
        truth = [chord_name(c) for c in ARPEGGIO] * 2
        at_start = live_replay(4.0, predictor="hmm")
        assert at_start[:8] == ["Am", "Am", "C", "G", "Am", "F", "C", "G"], at_start
        assert sum(a == t for a, t in zip(at_start, truth)) / len(truth) >= 0.5

    def test_first_bar_is_the_client_chord(self):
        """Bar 1 is Am not F on either lookahead: the `set.chord` rule holds until four notes,
        and the tick before bar 1 has heard two."""
        for predictor in ("table", "hmm"):
            assert live_replay(2.0, client_chord=None, predictor=predictor)[1] == "F"
            assert live_replay(2.0, predictor=predictor)[1] == "Am"


class TestChordDecision:
    @pytest.mark.parametrize("predictor", ["table", "hmm"])
    @pytest.mark.parametrize("lookahead", [0.0, 2.0, 4.0])
    def test_arpeggio_bar_start_accuracy_at_least_half(self, lookahead, predictor):
        brain = HarmonyBrain(key="A minor", lookahead_beats=lookahead, bpm=BPM, predictor=predictor)
        s = score(replay(brain), ARPEGGIO)
        assert s["bar_start"] >= 0.5, s["names"]

    def test_hmm_beats_the_table_on_the_arpeggio(self):
        for lookahead in (0.0, 4.0):
            hmm = HarmonyBrain(key="A minor", lookahead_beats=lookahead, bpm=BPM, predictor="hmm")
            table = HarmonyBrain(key="A minor", lookahead_beats=lookahead, bpm=BPM, predictor="table")
            assert score(replay(hmm), ARPEGGIO)["bar_start"] > score(replay(table), ARPEGGIO)["bar_start"]

    @pytest.mark.parametrize("predictor", ["table", "hmm"])
    @pytest.mark.parametrize("lookahead", [0.0, 2.0, 4.0])
    def test_onset_timestamps_decide_like_the_bench_arrival_replay(self, lookahead, predictor):
        """The brain ticks the harmonizer DETECTION_LATENCY_S behind the cue, so onset-stamped
        notes weigh exactly as the bench's arrival-stamped ones: same chords at every bar start."""
        brain = HarmonyBrain(key="A minor", lookahead_beats=lookahead, bpm=BPM, predictor=predictor)
        ours = score(replay(brain), ARPEGGIO)["names"]
        bench = score(run(ARPEGGIO, use_predictor=predictor, lookahead=lookahead), ARPEGGIO)["names"]
        assert ours == bench

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
        assert not r["idle"] and r["section"] == "intro"

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
