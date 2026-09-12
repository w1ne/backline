"""Playback constraints for a duet: leave room and use the performer's harmony."""
import math
import re


def shape_notes(notes, start, end, beat_seconds, space, time_resolution=100):
    # Quarter notes under the player, eighth notes for short answering phrases.
    gap = beat_seconds * (0.5 if space else 1.0)
    # Answer for at most two beats, then hand the phrase back to the performer.
    if space:
        end = min(end, start + 2 * beat_seconds)
    start_tick, end_tick = round(start * time_resolution), round(end * time_resolution)
    kept = []
    # Notes are (onset, duration, pitch) or (onset, duration, instrument, pitch); any
    # fields between duration and pitch pass through untouched.
    for onset, duration, *rest, pitch in sorted(notes):
        if not all(math.isfinite(v) for v in (onset, duration, pitch)):
            continue
        if not start_tick <= round(onset * time_resolution) < end_tick or duration <= 0 or not 0 <= pitch <= 127:
            continue
        onset = max(start, onset)
        if kept and onset - kept[-1][0] < gap - 1e-6:
            continue
        kept.append((onset, min(duration, end - onset), *rest, pitch))
    # The trimmed durations must go on the wire, not just into the model's history.
    return [(t, min(d, kept[i + 1][0] - t) if i + 1 < len(kept) else d, *rest)
            for i, (t, d, *rest) in enumerate(kept)]


def bass_pitch(chord, key):
    for harmony in (chord, key):
        match = re.match(r'^([A-G])([#b]?)', harmony or '')
        if match:
            root = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}[match[1]]
            root += {'': 0, '#': 1, 'b': -1}[match[2]]
            return 36 + root % 12
    return None
