"""Synthetic melody generator standing in for a live performer (built with musicpy)."""

import random

import musicpy as mp


def make_synthetic_melody(key="C", mode="major", n_notes=40, beat_s=0.6, seed=0):
    """Return (events, length_s) where events is a list of (onset_s, dur_s, pitch)."""
    rng = random.Random(seed)
    pitches = [n.degree for n in mp.scale(key, mode).notes]  # one octave, e.g. C4..C5

    durations_beats = [1.0, 1.0, 0.5, 0.5, 1.5]
    steps = [-2, -1, -1, 0, 1, 1, 1, 2]

    degree = 0
    t = 0.0
    events = []
    for i in range(n_notes):
        if i % 8 == 7:
            degree = 0  # cadence back to the tonic every couple of bars
        else:
            degree = max(0, min(len(pitches) - 1, degree + rng.choice(steps)))
        pitch = pitches[degree]
        dur_s = rng.choice(durations_beats) * beat_s
        events.append((t, dur_s * 0.9, pitch))
        t += dur_s
    return events, t
