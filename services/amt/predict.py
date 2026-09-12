"""Next-chord prediction: a first-order transition table over diatonic degrees, blended with
the melody harmonizer's reading of the current half bar.

Degrees are 0-based scale degrees (0 = I/i ... 6 = vii/VII). Only the six triads the
harmonizer may sit on appear as targets, so a prediction is always something the band
already knows how to voice.
"""
from __future__ import annotations

from typing import Optional, Sequence

from harmony import Chord, Key, Reading, diatonic_triads, tonic_triad

# Major: I ii iii IV V vi
MAJOR_TABLE: dict[int, dict[int, float]] = {
    0: {3: 0.35, 4: 0.30, 5: 0.20, 1: 0.15},
    1: {4: 0.70, 3: 0.30},
    2: {5: 0.60, 3: 0.40},
    3: {4: 0.50, 0: 0.30, 1: 0.20},
    4: {0: 0.70, 5: 0.30},
    5: {3: 0.50, 1: 0.30, 4: 0.20},
}
# Natural minor: i III iv v VI VII
MINOR_TABLE: dict[int, dict[int, float]] = {
    0: {5: 0.30, 6: 0.30, 3: 0.20, 4: 0.20},
    5: {6: 0.50, 3: 0.30, 2: 0.20},
    6: {0: 0.70, 2: 0.30},
    3: {4: 0.40, 0: 0.30, 6: 0.30},
    4: {0: 0.70, 5: 0.30},
    2: {6: 0.50, 5: 0.50},
}

# Genre tweaks: (mode, from_degree, to_degree) -> multiplier, renormalised afterwards.
GENRE_BOOST: dict[str, dict[tuple[str, int, int], float]] = {
    'jazz': {('major', 1, 4): 1.4, ('major', 4, 0): 1.4, ('minor', 3, 4): 1.4, ('minor', 4, 0): 1.4},
    'rock': {('major', 0, 3): 1.5, ('major', 0, 4): 1.5, ('minor', 0, 5): 1.5, ('minor', 0, 6): 1.5},
    'lofi': {('major', 0, 5): 1.8, ('major', 0, 3): 1.4, ('major', 4, 5): 1.5,
             ('minor', 0, 5): 1.5, ('minor', 0, 3): 1.5},
}

# The harmonizer's reading is trusted outright at this half-bar coverage.
READING_TRUST = 0.75
# A predicted chord must explain this much of the half bar's sung energy to replace the reading.
PREDICT_MIN_COVERAGE = 0.5

HEARD = 'heard'
PREDICTED = 'predicted'


def _triad_by_degree(key: Key) -> dict[int, Chord]:
    scale_order = [0, 4, 3, 5, 1, 2] if key.mode == 'major' else [0, 4, 5, 3, 6, 2]
    return dict(zip(scale_order, diatonic_triads(key)))


def degree_chord(key: Key, degree: int) -> Chord:
    return _triad_by_degree(key)[degree]


def chord_degree(key: Key, chord: Chord) -> Optional[int]:
    """The diatonic degree of `chord` in `key`, or None when it is not one of the six triads."""
    for deg, c in _triad_by_degree(key).items():
        if c == chord:
            return deg
    return None


def transitions(key: Key, degree: int, genre: Optional[str] = None) -> dict[int, float]:
    """Successor probabilities for `degree` in `key`, with the genre's taste applied and renormalised."""
    table = MAJOR_TABLE if key.mode == 'major' else MINOR_TABLE
    row = table.get(degree)
    if not row:
        return {}
    boosts = GENRE_BOOST.get((genre or '').lower(), {})
    out = {to: p * boosts.get((key.mode, degree, to), 1.0) for to, p in row.items()}
    total = sum(out.values())
    return {to: p / total for to, p in out.items()}


def predict_next(key: Key, recent_chords: Sequence[Chord], genre: Optional[str] = None) -> Chord:
    """The most likely next chord after the last of `recent_chords` (the tonic when there is none).

    First-order: only the last chord matters. Ties go to the successor listed first in the table.
    """
    last = recent_chords[-1] if recent_chords else tonic_triad(key)
    degree = chord_degree(key, last)
    if degree is None:
        degree = 0
    row = transitions(key, degree, genre)
    if not row:
        return tonic_triad(key)
    best = max(row, key=lambda d: row[d])
    return degree_chord(key, best)


def rejected(predicted: Chord, in_force: Chord, recent_chords: Sequence[Chord]) -> bool:
    """True when the band already tried `predicted` after `in_force` and the singer pulled it back.

    `recent_chords` is one entry per half bar; the pattern in_force, predicted, ..., in_force
    means the move was made and corrected, so a singer holding one chord is not pushed off it
    on every downbeat.
    """
    history = list(recent_chords)
    if predicted not in history or history[-1] != in_force:
        return False
    return in_force in history[history.index(predicted) + 1:]


def decide(key: Key, genre: Optional[str], harmonizer_reading: Optional[Reading],
           recent_chords: Sequence[Chord], coverage: float, downbeat: bool = False) -> tuple[Chord, str]:
    """The chord for the coming half bar and where it came from (HEARD or PREDICTED).

    - No reading yet: predict from what the band last played.
    - On a downbeat where the reading merely confirms the chord already in force, take the
      prediction: songs change chords on the one, and the previous half bar cannot tell us
      about the bar that has not started. A reading that *corrects* the chord in force wins.
    - The reading is trusted outright when it covers READING_TRUST of the half bar.
    - Otherwise the prediction wins if it explains PREDICT_MIN_COVERAGE of the half bar's energy.
    """
    if harmonizer_reading is None:
        return predict_next(key, recent_chords, genre), PREDICTED
    heard = harmonizer_reading.chord
    in_force = recent_chords[-1] if recent_chords else None
    if downbeat and in_force is not None and heard == in_force:
        predicted = predict_next(key, recent_chords, genre)
        if not rejected(predicted, in_force, recent_chords):
            return predicted, PREDICTED
        return heard, HEARD
    if coverage >= READING_TRUST or harmonizer_reading.energy <= 0:
        return heard, HEARD
    predicted = predict_next(key, recent_chords, genre)
    if harmonizer_reading.half_bar_coverage(predicted) >= PREDICT_MIN_COVERAGE:
        return predicted, PREDICTED
    return heard, HEARD
