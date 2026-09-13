"""Next-chord prediction over diatonic degrees, blended with the melody harmonizer's reading
of the current half bar.

Two predictors share one interface:

- `predict_next`: the hand-written first-order table (MAJOR_TABLE / MINOR_TABLE + GENRE_BOOST).
- `predict_next_hmm`: transitions learned from the Chordonomicon corpus (data/transitions.json,
  fitted by fit_transitions.py: first- and second-order degree counts, add-0.5 smoothing, per
  genre where the corpus has one), with a Viterbi decode of the last two bars of half-bar
  coverage vectors to settle which chord the singer is actually on before stepping forward.

Degrees are 0-based scale degrees (0 = I/i ... 6 = vii/VII). Only the six triads the
harmonizer may sit on appear as targets, so a prediction is always something the band
already knows how to voice.
"""
from __future__ import annotations

import json
import math
from functools import lru_cache
from pathlib import Path
from typing import Callable, Optional, Sequence

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

LEARNED_PATH = Path(__file__).with_name('data') / 'transitions.json'
# Emission sharpness for the Viterbi decode: coverage ** EMISSION_ALPHA (tuned on bench_harmony.py).
EMISSION_ALPHA = 2.0
# The chance the chord holds across a bar line and across a mid-bar half-bar boundary; the rest
# is spread by the learned first-order row.
STAY_PROB_BAR = 0.35
STAY_PROB_HALF = 0.85
# Half bars of coverage the decode looks back over: two bars.
HMM_WINDOW = 4
# Half bars of band decisions kept for `rejected()`: three bars, so a push two bars back is still
# in view together with the chord it was pushed off.
RECENT_HALF_BARS = 6
EMISSION_FLOOR = 1e-3
# A triad whose root was actually sung in the half bar has its coverage scaled by 1 + ROOT_BONUS:
# two sung notes fit several triads fully, and the root breaks the tie the way the harmonizer does.
ROOT_BONUS = 0.5


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


# -- learned transitions + Viterbi ------------------------------------------------------------

@lru_cache(maxsize=1)
def learned() -> Optional[dict]:
    """The fitted matrices from data/transitions.json, or None when the file is missing."""
    try:
        with open(LEARNED_PATH) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _mode_data(key: Key) -> Optional[dict]:
    data = learned()
    return data['modes'][key.mode] if data else None


def learned_first(key: Key, genre: Optional[str] = None) -> dict[int, dict[int, float]]:
    """First-order successor probabilities by degree, the genre's own matrix when the corpus has one."""
    md = _mode_data(key)
    if md is None:
        return {}
    data = learned()
    rows = md['first']
    g = data['genre_map'].get((genre or '').lower())
    if g and g in data['genres']:
        rows = data['genres'][g][key.mode]
    degs = md['degrees']
    return {degs[i]: {degs[j]: p for j, p in enumerate(row) if p > 0} for i, row in enumerate(rows)}


def learned_second(key: Key, prev: int, cur: int, genre: Optional[str] = None) -> dict[int, float]:
    """Successor probabilities after the pair (prev, cur).

    The genre's first-order matrix acts as a learned multiplier on the mode's second-order row
    (renormalised): the rarer pair counts are not fitted per genre.
    """
    md = _mode_data(key)
    if md is None:
        return {}
    degs = md['degrees']
    if prev not in degs or cur not in degs:
        return {}
    row = md['second'][degs.index(prev)][degs.index(cur)]
    base = md['first'][degs.index(cur)]
    genre_row = learned_first(key, genre).get(cur, {})
    out = {}
    for j, p in enumerate(row):
        if p <= 0:
            continue
        mult = genre_row.get(degs[j], 0.0) / base[j] if base[j] > 0 and genre_row else 1.0
        out[degs[j]] = p * mult
    total = sum(out.values())
    return {d: p / total for d, p in out.items()} if total > 0 else {}


def _distinct_degrees(key: Key, chords: Sequence[Chord]) -> list[int]:
    """Degrees of `chords` with repeats collapsed and non-diatonic chords dropped."""
    out: list[int] = []
    for c in chords:
        d = chord_degree(key, c)
        if d is not None and (not out or out[-1] != d):
            out.append(d)
    return out


def _stay_probs(n_steps: int, downbeat: bool) -> list[float]:
    """Per transition of a window of `n_steps` half-bar emissions, the chance the chord holds.

    Transition i leads into emission i (i >= 1). The last emission ends at the tick; when the tick
    is a downbeat that half bar started mid-bar, so the transition into it is a mid-bar one, the
    one before crosses a bar line, and so on back.
    """
    out = []
    for i in range(1, n_steps):
        steps_back = n_steps - 1 - i  # 0 for the transition into the last emission
        crosses_bar = (steps_back % 2 == 1) if downbeat else (steps_back % 2 == 0)
        out.append(STAY_PROB_BAR if crosses_bar else STAY_PROB_HALF)
    return out


def viterbi(key: Key, genre: Optional[str], emissions: Sequence[Sequence[float]],
            alpha: float = EMISSION_ALPHA, prior: Optional[Chord] = None,
            downbeat: bool = True) -> list[int]:
    """Most likely degree per half bar given per-half-bar coverage over diatonic_triads(key).

    Transition per half bar: a stay probability on the diagonal (STAY_PROB_BAR when the step
    crosses a bar line, STAY_PROB_HALF mid-bar; `downbeat` says whether the last emission ends on
    one), the learned first-order row for the rest. Emission: coverage ** alpha (floored so a
    silent half bar does not kill a path). The first step starts from `prior` (the chord in force
    before the window) when given, else uniformly.
    """
    triads = diatonic_triads(key)
    degs = [chord_degree(key, c) for c in triads]
    n = len(triads)
    first = learned_first(key)  # the mode row: the decode identifies, the genre taste steps forward

    def log_trans(stay: float) -> list[list[float]]:
        out = []
        for di in degs:
            row = first.get(di, {})
            probs = [stay if dj == di else (1 - stay) * row.get(dj, 0.0) for dj in degs]
            out.append([math.log(p) if p > 0 else -math.inf for p in probs])
        return out

    def log_emit(vec):
        return [math.log(max(float(v), 0.0) ** alpha + EMISSION_FLOOR) for v in vec]

    prior_deg = chord_degree(key, prior) if prior is not None else None
    score = [0.0 if prior_deg is None or prior_deg == d else math.log(EMISSION_FLOOR) for d in degs]
    score = [s + e for s, e in zip(score, log_emit(emissions[0]))]
    back: list[list[int]] = []
    for vec, stay in zip(emissions[1:], _stay_probs(len(emissions), downbeat)):
        e = log_emit(vec)
        lt = log_trans(stay)
        new, bp = [], []
        for j in range(n):
            best_i = max(range(n), key=lambda i: score[i] + lt[i][j])
            new.append(score[best_i] + lt[best_i][j] + e[j])
            bp.append(best_i)
        score = new
        back.append(bp)
    state = max(range(n), key=lambda i: score[i])
    path = [state]
    for bp in reversed(back):
        state = bp[state]
        path.append(state)
    path.reverse()
    return [degs[i] for i in path]


def decode_current(key: Key, genre: Optional[str], recent_chords: Sequence[Chord],
                   emissions: Optional[Sequence[Sequence[float]]], alpha: float = EMISSION_ALPHA,
                   downbeat: bool = True) -> tuple[Optional[int], int]:
    """(previous distinct degree or None, current degree) the singer is on.

    From the Viterbi path over `emissions` (the last HMM_WINDOW half bars, oldest first) when
    given; only what the singer was decoded on counts as the previous chord, since the band's own
    moves in `recent_chords` may be pushes the singer pulled back. Without emissions, from
    `recent_chords`; with nothing at all, the tonic.
    """
    if emissions:
        window = list(emissions)[-HMM_WINDOW:]
        prior = recent_chords[-len(window) - 1] if len(recent_chords) > len(window) else None
        path = viterbi(key, genre, window, alpha, prior, downbeat)
        decoded = [d for i, d in enumerate(path) if i == 0 or d != path[i - 1]]
        return (decoded[-2] if len(decoded) >= 2 else None), decoded[-1]
    history = _distinct_degrees(key, recent_chords)
    if history:
        return (history[-2] if len(history) >= 2 else None), history[-1]
    return None, 0


def predict_next_hmm(key: Key, genre: Optional[str], recent_chords: Sequence[Chord],
                     emissions: Optional[Sequence[Sequence[float]]], alpha: float = EMISSION_ALPHA,
                     downbeat: bool = True) -> Chord:
    """The most likely next chord from the learned transitions.

    `emissions` are the harmonizer's per-half-bar coverage vectors over diatonic_triads(key) for
    the last HMM_WINDOW half bars (oldest first), the newest ending on a downbeat unless said
    otherwise. The current chord and the one before it come from `decode_current`; the step
    forward uses the second-order row when a previous distinct chord is known, else the
    first-order row, and never picks the chord already in force. Falls back to the table when no
    fitted data is present.
    """
    if learned() is None:
        return predict_next(key, recent_chords, genre)
    prev, cur = decode_current(key, genre, recent_chords, emissions, alpha, downbeat)
    return degree_chord(key, _step(key, genre, prev, cur))


def _step(key: Key, genre: Optional[str], prev: Optional[int], cur: int) -> int:
    """The most likely degree after (prev, cur), never cur itself; the tonic's degree as a last resort."""
    row = learned_second(key, prev, cur, genre) if prev is not None else {}
    if not row:
        row = learned_first(key, genre).get(cur, {})
    row = {d: p for d, p in row.items() if d != cur}
    if not row:
        return 0
    return max(row, key=lambda d: row[d])


def predict_ahead_hmm(key: Key, genre: Optional[str], recent_chords: Sequence[Chord],
                      sources: Optional[Sequence[str]], emissions: Optional[Sequence[Sequence[float]]],
                      downbeat: bool, chord: Chord, downbeats_ahead: int) -> Chord:
    """The chord in force `downbeats_ahead` bar lines past the tick, for a plan committed early.

    `chord` is this tick's decision (the last of `recent_chords`). The chain starts from the
    decoded (previous, current) pair; on a downbeat the decision is already the coming bar's
    chord and joins the chain, then each bar line crossed takes one second-order step. A step
    `rejected()` by the singer's recent pull-back stops the walk: the band holds.
    """
    if learned() is None:
        target = chord
        for _ in range(downbeats_ahead):
            target = predict_next(key, [target], genre)
        return target
    prev, cur = decode_current(key, genre, recent_chords, emissions, downbeat=downbeat)
    chain = [d for d in (prev, cur) if d is not None]
    cd = chord_degree(key, chord)
    if downbeat and cd is not None and cd != chain[-1]:
        chain.append(cd)
    target = chord
    for _ in range(downbeats_ahead):
        nxt = _step(key, genre, chain[-2] if len(chain) >= 2 else None, chain[-1])
        nxt_chord = degree_chord(key, nxt)
        if rejected(nxt_chord, target, recent_chords, sources):
            break
        chain.append(nxt)
        target = nxt_chord
    return target


def hmm_reading(key: Key, genre: Optional[str], reading: Reading, recent_chords: Sequence[Chord],
                emissions: Sequence[Sequence[float]], alpha: float = EMISSION_ALPHA,
                downbeat: bool = True) -> Reading:
    """The harmonizer's reading with its chord replaced by the Viterbi-decoded current chord.

    The harmonizer remembers 1.5 windows with a fade, so on a downbeat it often still names the
    chord of the previous bar; the decode over the last two bars settles on the bar just ended.
    """
    if learned() is None or not emissions:
        return reading
    _prev, cur = decode_current(key, genre, recent_chords, emissions, alpha, downbeat)
    return Reading(degree_chord(key, cur), reading.half_bar_weights)


def emission_vector(reading: Optional[Reading], key: Key) -> list[float]:
    """The reading's half-bar coverage over diatonic_triads(key); all zeros when nothing was sung."""
    if reading is None:
        return [0.0] * 6
    w = reading.half_bar_weights
    return [reading.half_bar_coverage(c) * (1.0 + ROOT_BONUS if w[c.root % 12] > 0 else 1.0)
            for c in diatonic_triads(key)]


Predictor = Callable[[Sequence[Chord]], Chord]


def rejected(predicted: Chord, in_force: Chord, recent_chords: Sequence[Chord],
             sources: Optional[Sequence[str]] = None) -> bool:
    """True when the band already pushed off `in_force` and the singer pulled it back.

    `recent_chords` is one entry per half bar. Without `sources` the pattern predicted, ...,
    in_force means the move was made and corrected, so a singer holding one chord is not pushed
    off it on every downbeat. With `sources` (HEARD/PREDICTED per entry) a push is a PREDICTED
    entry other than in_force that followed in_force and was followed by in_force again; any
    such push blocks every move this downbeat, since the singer is holding. The window should
    hold RECENT_HALF_BARS entries so a push two bars back is still in view with its predecessor.
    A singer who went predicted -> in_force on their own does not block the way back, and a
    push off some other chord that the singer answered with in_force is not a pull-back.
    """
    history = list(recent_chords)
    if not history or history[-1] != in_force:
        return False
    if sources is None:
        if predicted not in history:
            return False
        return in_force in history[history.index(predicted) + 1:]
    for i, c in enumerate(history):
        if (i > 0 and sources[i] == PREDICTED and c != in_force and history[i - 1] == in_force
                and in_force in history[i + 1:]):
            return True
    return False


def decide(key: Key, genre: Optional[str], harmonizer_reading: Optional[Reading],
           recent_chords: Sequence[Chord], coverage: float, downbeat: bool = False,
           predictor: Optional[Predictor] = None,
           sources: Optional[Sequence[str]] = None,
           predict_through_corrections: bool = False) -> tuple[Chord, str]:
    """The chord for the coming half bar and where it came from (HEARD or PREDICTED).

    `predictor(recent_chords)` names the next chord; the table (`predict_next`) when not given.
    `sources` are the HEARD/PREDICTED tags of `recent_chords`, for `rejected()`.
    `predict_through_corrections`: on a downbeat, predict even when the reading corrects the chord
    in force (the hmm path: its reading is the decoded bar that just ended, and the coming bar is
    more likely a step on from it than a late copy of it).

    - No reading yet: predict from what the band last played.
    - On a downbeat where the reading merely confirms the chord already in force, take the
      prediction: songs change chords on the one, and the previous half bar cannot tell us
      about the bar that has not started. A reading that *corrects* the chord in force wins.
    - The reading is trusted outright when it covers READING_TRUST of the half bar.
    - Otherwise the prediction wins if it explains PREDICT_MIN_COVERAGE of the half bar's energy.
    """
    if predictor is None:
        predictor = lambda recent: predict_next(key, recent, genre)
    if harmonizer_reading is None:
        return predictor(recent_chords), PREDICTED
    heard = harmonizer_reading.chord
    in_force = recent_chords[-1] if recent_chords else None
    if downbeat and in_force is not None and (heard == in_force or predict_through_corrections):
        predicted = predictor(recent_chords)
        if not rejected(predicted, in_force, recent_chords, sources):
            return predicted, PREDICTED
        return heard, HEARD
    if coverage >= READING_TRUST or harmonizer_reading.energy <= 0:
        return heard, HEARD
    predicted = predictor(recent_chords)
    if harmonizer_reading.half_bar_coverage(predicted) >= PREDICT_MIN_COVERAGE:
        return predicted, PREDICTED
    return heard, HEARD
