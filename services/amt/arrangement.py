"""Playback constraints for a duet: leave room and use the performer's harmony."""
import math
import re


def shape_notes(notes, start, end, beat_seconds, space, time_resolution=100, key=None, chord=None, creativity=0.0, amount=0.5):
    creativity = max(0.0, min(1.0, creativity))
    amount = max(0.0, min(1.0, amount))
    if amount == 0:
        return []
    # Amount controls room left for the performer; creativity unlocks subdivisions.
    grid_beats = .25 if creativity >= .65 else .5
    gap_beats = 2.0 if amount < .25 else 1.0 if amount < .7 else .5
    gap = beat_seconds * max(grid_beats, gap_beats * (.5 if space else 1.0))
    # Answer for at most two beats, then hand the phrase back to the performer.
    if space:
        end = min(end, start + 2 * beat_seconds)
    start_tick, end_tick = round(start * time_resolution), round(end * time_resolution)
    chord_tones = harmony_classes(key, chord)
    scale_tones = harmony_classes(key)
    kept = []
    # Notes are (onset, duration, pitch) or (onset, duration, instrument, pitch); any
    # fields between duration and pitch pass through untouched.
    for onset, duration, *rest, pitch in sorted(notes):
        if not all(math.isfinite(v) for v in (onset, duration, pitch)):
            continue
        if not start_tick <= round(onset * time_resolution) < end_tick or duration <= 0 or not 0 <= pitch <= 127:
            continue
        relative_beat = max(0, (onset - start) / beat_seconds)
        grid_index = math.floor(relative_beat / grid_beats + .5)
        onset = start + grid_index * grid_beats * beat_seconds
        if onset >= end - 1e-8:
            continue
        duration = max(grid_beats, round(duration / beat_seconds / grid_beats) * grid_beats) * beat_seconds
        # Simple phrases stay on chord tones; adventurous phrases can use scale
        # passing tones between strong beats without turning into random chromatic notes.
        strong_beat = abs(grid_index * grid_beats % 1) < 1e-8
        allowed = scale_tones if space or (creativity >= .5 and not strong_beat) else chord_tones
        if allowed:
            # Keep the model's contour/register while removing clashes against
            # the performer's harmony. Ties prefer the lower supporting note.
            pitch = min((p for p in range(max(0, pitch-6), min(127, pitch+6)+1)
                         if p % 12 in allowed), key=lambda p: (abs(p-pitch), p))
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


def harmony_classes(key, chord=None):
    harmony = chord or key
    match = re.match(r'^([A-G])([#b]?)(.*)$', harmony or '')
    if not match:
        return set()
    root = bass_pitch(harmony, None) % 12
    quality = match[3].strip().lower()
    minor = quality.startswith('min') or (quality.startswith('m') and not quality.startswith('maj'))
    if chord:
        intervals = [0,3,7] if minor else [0,4,7]
        if quality.startswith('dim'): intervals = [0,3,6]
        elif quality.startswith('sus4'): intervals = [0,5,7]
        if '7' in quality: intervals += [11 if quality.startswith('maj') else 10]
    else:
        intervals = [0,2,3,5,7,8,10] if minor else [0,2,4,5,7,9,11]
    return {(root+i)%12 for i in intervals}
