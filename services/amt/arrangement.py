"""Playback constraints for a duet: leave room and use the performer's harmony."""
import math
import re


def plan_window(now_beat, span_beats, lookahead_beats=4.0):
    """The window a cue at `now_beat` asks a plan for: it starts `lookahead_beats`
    past the cue and runs for `span_beats`. A `bar` cue at beat 4*bar with a
    four-beat span gives the old one-bar-ahead window ((bar+1)*4, (bar+2)*4);
    a `tick` cue every two beats with a two-beat span tiles the same timeline
    in half bars, each still committed one bar ahead."""
    start = now_beat + lookahead_beats
    return (start, start + span_beats)


def shape_notes(notes, start, end, beat_seconds, space, time_resolution=100, key=None, chord=None, creativity=0.0, amount=0.5):
    creativity = max(0.0, min(1.0, creativity))
    amount = max(0.0, min(1.0, amount))
    if amount == 0:
        return []
    # Amount controls room left for the performer; creativity unlocks subdivisions.
    grid_beats = .25 if creativity >= .65 else .5
    gap_beats = 2.0 if amount < .25 else 1.0 if amount < .7 else .5
    # Above 0.8, creativity gets a "wild" end: the density cap rises as the
    # minimum note spacing is pulled down from the amount-driven gap toward
    # the 0.25-beat grid, reaching exactly the grid at creativity == 1.0.
    wild = min(1.0, max(0.0, creativity - .8) / .2)
    if wild:
        gap_beats = gap_beats - (gap_beats - grid_beats) * wild
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
        # Wild creativity (>= 0.8) lets strong beats reach for scale tones too;
        # they still never leave the scale.
        allowed = scale_tones if space or creativity >= .8 or (creativity >= .5 and not strong_beat) else chord_tones
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


def voice_chord(pitch, chord_tones, want=3):
    """Build a keys voicing around `pitch`: up to `want` simultaneous notes,
    all chord tones, stacked within a couple of octaves of the seed pitch.

    The seed is first snapped to the nearest chord tone (same nearest-pitch
    search shape_notes uses for melodic correction), so every note this
    returns -- not just the extra ones -- is guaranteed to be a chord tone.
    Without `chord_tones` (no key/chord known yet) it returns the pitch
    unchanged, i.e. today's monophonic behavior.
    """
    if not chord_tones or want <= 1:
        return [pitch]
    seed = min((p for p in range(max(0, pitch - 6), min(127, pitch + 6) + 1)),
               key=lambda p: (0 if p % 12 in chord_tones else 1, abs(p - pitch), p))
    notes = [seed]
    used_pcs = {seed % 12}
    octave_base = seed - seed % 12
    candidates = sorted(
        {octave_base + pc + off for off in (12, -12, 24, 0) for pc in chord_tones
         if pc not in used_pcs and 0 <= octave_base + pc + off <= 127},
        key=lambda p: abs(p - seed),
    )
    for p in candidates:
        if len(notes) >= want:
            break
        pc = p % 12
        if pc in used_pcs:
            continue
        notes.append(p)
        used_pcs.add(pc)
    return sorted(notes)


def early_entry_plan(key, chord, start_beat, end_beat):
    """Key-only fallback plan for a bar still inside the listen window (fewer
    than `listenBeats` of human input): a singer waiting on the model's
    first `plan` message otherwise hears nothing until beat 8
    (listenBeats=4 + one bar lead time). Bass hits the chord root on beats 1
    and 3 of the bar; keys holds a voiced chord from beat 1 through the bar.
    Both come straight from the key/chord the client already sent with
    `start`/`set` -- no melody needed -- so this can cover bar 1, before the
    model has anything to answer. Returns [] if neither key nor chord is
    known yet (nothing to build a plan from).
    """
    root = bass_pitch(chord, key)
    if root is None:
        return []
    bar_len = end_beat - start_beat
    half = bar_len / 2.0
    notes = [
        {"beat": start_beat, "pitch": root, "dur": half, "vel": 0.5, "voice": "bass"},
        {"beat": start_beat + half, "pitch": root, "dur": half, "vel": 0.5, "voice": "bass"},
    ]
    chord_tones = harmony_classes(key, chord) or harmony_classes(key)
    for pitch in voice_chord(60, chord_tones, want=3):
        notes.append({"beat": start_beat, "pitch": pitch, "dur": bar_len, "vel": 0.45, "voice": "keys"})
    return notes


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


def fill_silent_window(notes_out, key, chord, start_beat, end_beat):
    """The model sometimes commits nothing for a window (little human context,
    or every generated note landed outside it). A band that goes quiet for a
    bar sounds like a dropout, so when no keys note was committed the window
    gets the same key-only plan the listen phase uses: bass root on 1 and 3,
    a voiced chord on 1. Returns `notes_out` untouched when it has keys notes
    or when no key/chord is known."""
    if any(n.get("voice") == "keys" for n in notes_out):
        return notes_out
    plan = early_entry_plan(key, chord, start_beat, end_beat)
    return plan if plan else notes_out

