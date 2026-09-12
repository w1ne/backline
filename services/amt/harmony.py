"""Melody harmonizer: a port of the single-voice path of src/listener/chordDetector.ts.

Time is unitless here; the service feeds beats, the browser fed seconds. The constants
below mirror the TS file name for name so the two stay comparable.
"""
from __future__ import annotations

import re
from typing import NamedTuple, Optional, Sequence

NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
MAJOR = [0, 2, 4, 5, 7, 9, 11]
MINOR = [0, 2, 3, 5, 7, 8, 10]

QUALITY_TONES = {
    'maj': [0, 4, 7],
    'min': [0, 3, 7],
    'dom7': [0, 4, 7, 10],
    'min7': [0, 3, 7, 10],
    'maj7': [0, 4, 7, 11],
    'sus4': [0, 5, 7],
    'dim': [0, 3, 6],
}
SUFFIX = {'maj': '', 'min': 'm', 'dom7': '7', 'min7': 'm7', 'maj7': 'maj7', 'sus4': 'sus4', 'dim': 'dim'}

# Notes at or below this MIDI number count 1.5x: the bass note names the chord.
BASS_MAX_MIDI = 55  # G3
BASS_BOOST = 1.5
# Harmonizer memory as a multiple of the chord window (two beats).
MELODY_WINDOW_MUL = 1.5
# A rival must cover this much more of the sung energy than the held chord to replace it.
MELODY_SWITCH_MARGIN = 0.15
# Below this coverage no diatonic triad explains the melody; the held chord (or tonic) stays.
MELODY_MIN_COVERAGE = 0.5


class Chord(NamedTuple):
    root: int
    quality: str = 'maj'

    def name(self) -> str:
        return chord_name(self)


class Key(NamedTuple):
    root: int
    mode: str  # 'major' | 'minor'


def mod12(n: int) -> int:
    return n % 12


def chord_name(c: Chord) -> str:
    """Exactly what chordName in chordDetector.ts produces: C, C#, Am, G7, ..."""
    return NAMES[mod12(c.root)] + SUFFIX[c.quality]


def chord_tones(c: Chord) -> list[int]:
    return [mod12(c.root + t) for t in QUALITY_TONES[c.quality]]


def scale_of(key: Key) -> list[int]:
    steps = MAJOR if key.mode == 'major' else MINOR
    return [(s + key.root) % 12 for s in steps]


def tonic_triad(key: Key) -> Chord:
    return Chord(key.root, 'maj' if key.mode == 'major' else 'min')


_KEY_RE = re.compile(r'^\s*([A-G])([#b]?)\s*(major|minor|maj|min|m)?\s*$', re.IGNORECASE)
_LETTER_PC = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}


def parse_key(s: Optional[str]) -> Optional[Key]:
    """'A minor' / 'C# major' as the client sends in `start` and `set` messages."""
    if not s:
        return None
    m = _KEY_RE.match(s)
    if not m:
        return None
    root = _LETTER_PC[m[1].upper()] + {'#': 1, 'b': -1, '': 0}[m[2]]
    mode = (m[3] or 'major').lower()
    return Key(mod12(root), 'minor' if mode.startswith('min') or mode == 'm' else 'major')


def pitch_class_weights(notes: Sequence[tuple], now: float, window: float, fade: bool = True) -> list[float]:
    """Pitch-class energy over the last `window` time units ending at `now`.

    Older notes fade linearly to zero at the edge of the window; bass notes count for more.
    Each note is (midi, t, weight).
    """
    w = [0.0] * 12
    for midi, t, *rest in notes:
        age = now - t
        if age < 0 or age >= window:
            continue
        decay = 1 - age / window if fade else 1.0
        boost = BASS_BOOST if midi <= BASS_MAX_MIDI else 1.0
        weight = rest[0] if rest and rest[0] is not None else 1.0
        w[mod12(midi)] += weight * decay * boost
    return w


def diatonic_triads(key: Key) -> list[Chord]:
    """The six diatonic triads of `key` the band may sit on, tonic first, then by harmonic weight."""
    scale = scale_of(key)
    order = [0, 4, 3, 5, 1, 2] if key.mode == 'major' else [0, 4, 5, 3, 6, 2]
    out = []
    for deg in order:
        root = scale[deg]
        third = mod12(scale[(deg + 2) % 7] - root)
        out.append(Chord(root, 'maj' if third == 4 else 'min'))
    return out


def coverage(weights: Sequence[float], chord: Chord) -> float:
    """Share of the pitch-class energy that lands on the chord's tones (0 when nothing sung)."""
    total = sum(weights)
    if total <= 0:
        return 0.0
    return sum(weights[pc] for pc in chord_tones(chord)) / total


def harmonize_melody(weights: Sequence[float], key: Key, held: Optional[Chord]) -> Chord:
    """Of the key's diatonic triads, the one whose tones carry the most of the sung energy.

    The held chord keeps its place unless a rival covers clearly more, ties fall to the tonic,
    and among equal coverage a triad whose root was actually sung wins. Nothing sung: the tonic.
    """
    total = sum(weights)
    candidates = diatonic_triads(key)
    tonic = candidates[0]
    if total <= 0:
        return held or tonic

    def cov(c: Chord) -> float:
        return sum(weights[pc] for pc in chord_tones(c)) / total

    if sum(1 for v in weights if v > 0) >= 2:
        def root_sung(c: Chord) -> float:
            return 1e-6 if weights[c.root] > 0 else 0.0
    else:
        def root_sung(c: Chord) -> float:
            return 0.0

    best, best_cov = tonic, cov(tonic)
    best_score = best_cov + root_sung(tonic)
    for c in candidates:
        cv = cov(c)
        score = cv + root_sung(c)
        if score > best_score + 1e-9:
            best, best_cov, best_score = c, cv, score
    if best_cov < MELODY_MIN_COVERAGE:
        return held or tonic
    if held and held != best and best_cov - cov(held) < MELODY_SWITCH_MARGIN:
        return held
    return best


class Reading:
    """What the harmonizer decided at the last tick, plus the energy of the current half bar."""

    def __init__(self, chord: Chord, half_bar_weights: list[float]):
        self.chord = chord
        self.half_bar_weights = half_bar_weights

    @property
    def coverage(self) -> float:
        return coverage(self.half_bar_weights, self.chord)

    @property
    def energy(self) -> float:
        return sum(self.half_bar_weights)

    def half_bar_coverage(self, chord: Chord) -> float:
        return coverage(self.half_bar_weights, chord)


class MelodyHarmonizer:
    """Rolling chord estimate over the notes the singer just sang.

    Notes go in as they happen (`add_note`); the chord is only re-decided when the service
    clock calls `tick()`, every half bar. `window` is two beats of the current tempo; the
    harmonizer remembers MELODY_WINDOW_MUL windows, fading, so the root a singer opened the
    bar on still counts on the second half.
    """

    def __init__(self, window: float = 2.0):
        self.window = window
        self.notes: list[tuple[int, float, float]] = []
        self.melody: Optional[Chord] = None
        self.reading: Optional[Reading] = None

    def add_note(self, pitch: int, beat: float, weight: float = 1.0) -> None:
        if pitch < 0:
            return
        self.notes.append((int(pitch), float(beat), float(weight)))
        cutoff = beat - self.window * 2
        if len(self.notes) > 64:
            self.notes = [n for n in self.notes if n[1] >= cutoff]

    def tick(self, now_beat: float, key: Optional[Key]) -> Optional[Chord]:
        if key is None:
            return None
        wm = pitch_class_weights(self.notes, now_beat, self.window * MELODY_WINDOW_MUL)
        self.melody = harmonize_melody(wm, key, self.melody)
        self.reading = Reading(self.melody, pitch_class_weights(self.notes, now_beat, self.window, fade=False))
        return self.melody

    def reset(self) -> None:
        self.notes = []
        self.melody = None
        self.reading = None
