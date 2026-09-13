"""Prompt-only context for the AMT sampler: a style prime and a chord pad.

The base checkpoint is unconditioned -- it never sees key, genre or chord, it only
continues "a MIDI file". Two prompt transforms fix most of the genericness without
touching the stored history:

* a two-bar **style prime** in the session's genre, transposed to its key, placed
  before beat 0 (the live history is shifted later by the prime's length) and voiced
  on the very instruments the pass is masked to, plus a melody line on the player's
  program so the model sees the duet relationship it is asked to continue;
* a **chord pad**: the chord the brain decided for this window, held on an unused
  program from two beats before the window through its end, so the model voices
  against real harmony instead of guessing it. The caller's `instr in group` filter
  drops the pad from the output.

Both are pure functions of (history, key, genre, chord); nothing here mutates the
session. `AMT_PRIME=0` / `AMT_CHORD_PAD=0` switch them off for A/B runs.
"""
import os

from amt import MELODY_INSTR, make_event, parse_events
from anticipation.config import TIME_RESOLUTION
from anticipation.vocab import TIME_OFFSET
from arrangement import harmony_classes, role_for_instrument
from harmony import parse_key

PRIME_ON = os.environ.get("AMT_PRIME", "1") != "0"
CHORD_PAD_ON = os.environ.get("AMT_CHORD_PAD", "1") != "0"

PAD_INSTR = 91          # GM pad 4 (choir) -- in no preset, so never reaches the output
PAD_LEAD_BEATS = 2.0    # the pad starts this far before the window so it reads as "held"
PRIME_BEATS = 8.0
PRIME_GAP_BEATS = 1.0   # one beat of silence between the prime and the live history

# (beat, duration_beats, role, midi) in C major / A minor. Roles map onto the programs of
# the pass ('bass' also serves cello); 'melody' is the player's program.
_C, _E, _G, _A, _B, _D, _F = 60, 64, 67, 69, 71, 62, 65
PRIMES = {
    "jazz": [
        # walking bass C6 | Am7 | Dm7 | G7 (two beats each) with 7th-chord shells on the ands
        (0, 1, "bass", 36), (1, 1, "bass", 40), (2, 1, "bass", 45), (3, 1, "bass", 43),
        (4, 1, "bass", 38), (5, 1, "bass", 41), (6, 1, "bass", 43), (7, 1, "bass", 47),
        (1.5, 1, "keys", _E), (1.5, 1, "keys", _B - 12), (1.5, 1, "keys", _A),
        (3.5, 1, "keys", _G), (3.5, 1, "keys", _C), (3.5, 1, "keys", _E),
        (5.5, 1, "keys", _F), (5.5, 1, "keys", _A), (5.5, 1, "keys", _C + 12),
        (7.5, 0.5, "keys", _F), (7.5, 0.5, "keys", _B), (7.5, 0.5, "keys", _D + 12),
        (0.5, 0.5, "lead", _G + 12), (1, 1, "lead", _E + 12), (4.5, 0.5, "lead", _F + 12), (5, 1, "lead", _D + 12),
        (0, 1.5, "melody", _E + 12), (1.5, 0.5, "melody", _D + 12), (2, 2, "melody", _C + 12),
        (4, 1, "melody", _A), (5, 0.5, "melody", _G), (5.5, 0.5, "melody", _A), (6, 2, "melody", _B),
    ],
    "lofi": [
        # Cmaj7 | Am7 held, bass on 1 and the and-of-3, a lazy guitar answer
        (0, 1.5, "bass", 36), (2.5, 1.5, "bass", 36), (4, 1.5, "bass", 33), (6.5, 1.5, "bass", 33),
        (0, 4, "keys", _E), (0, 4, "keys", _G), (0, 4, "keys", _B), (0, 4, "keys", _D + 12),
        (4, 4, "keys", _E), (4, 4, "keys", _G), (4, 4, "keys", _C + 12), (4, 4, "keys", _E + 12),
        (2, 0.5, "lead", _E + 12), (2.5, 1.5, "lead", _D + 12), (6, 0.5, "lead", _C + 12), (6.5, 1.5, "lead", _B),
        (0, 2, "melody", _G), (2, 1, "melody", _E), (3, 1, "melody", _D), (4, 3, "melody", _E), (7, 1, "melody", _C),
    ],
    "rock": [
        # driving eighths C5 | G5 power chords, bass on the root
        *[(b * 0.5, 0.5, "bass", 36) for b in range(8)], *[(4 + b * 0.5, 0.5, "bass", 43 - 12) for b in range(8)],
        (0, 2, "keys", _C - 12), (0, 2, "keys", _G - 12), (2, 2, "keys", _C - 12), (2, 2, "keys", _G - 12),
        (4, 2, "keys", _G - 12), (4, 2, "keys", _D), (6, 2, "keys", _G - 12), (6, 2, "keys", _D),
        (3, 0.5, "lead", _E + 12), (3.5, 0.5, "lead", _G + 12), (7, 1, "lead", _B),
        (0, 1, "melody", _E + 12), (1, 1, "melody", _E + 12), (2, 0.5, "melody", _D + 12), (2.5, 1.5, "melody", _C + 12),
        (4, 1, "melody", _B), (5, 1, "melody", _D + 12), (6, 2, "melody", _B),
    ],
    "funk": [
        # syncopated octave bass on C7, clav-style stabs on the ands
        (0, 0.25, "bass", 36), (0.75, 0.25, "bass", 48), (1.5, 0.25, "bass", 36), (2, 0.25, "bass", 36),
        (2.75, 0.25, "bass", 46), (3.5, 0.5, "bass", 48),
        (4, 0.25, "bass", 36), (4.75, 0.25, "bass", 48), (5.5, 0.25, "bass", 36), (6, 0.25, "bass", 36),
        (6.75, 0.25, "bass", 46), (7.5, 0.5, "bass", 43),
        *[(b, 0.25, "keys", p) for b in (0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5) for p in (_E, _G + 12 - 12, 70)],
        (1.75, 0.25, "lead", _G + 12), (2, 0.5, "lead", _E + 12), (5.75, 0.25, "lead", 70 + 12), (6, 0.5, "lead", _G + 12),
        (0, 0.5, "melody", _G), (0.5, 0.5, "melody", 70), (1, 1, "melody", _C + 12), (2.5, 0.5, "melody", 70),
        (3, 1, "melody", _G), (4, 0.5, "melody", _E), (4.5, 0.5, "melody", _G), (5, 3, "melody", _C + 12),
    ],
}
# Minor keys use the relative major prime shifted so its tonic lands on the minor tonic
# (the jazz/lofi primes already spend half their bars on the vi chord).
MINOR_SHIFT = 3


def _transposition(key):
    parsed = parse_key(key)
    if parsed is None:
        return 0
    semis = parsed.root if parsed.mode == "major" else (parsed.root + MINOR_SHIFT) % 12
    # Keep the prime near its written register: transpose down past a tritone.
    return semis - 12 if semis > 6 else semis


def prime_events(genre, key, group, beat_s):
    """(time_s, dur_s, instr, pitch) for the prime, voiced on `group` + the melody program."""
    lines = PRIMES.get(genre or "", PRIMES["lofi"])
    semis = _transposition(key)
    by_role = {}
    for instr in group:
        by_role.setdefault(role_for_instrument(instr), []).append(instr)
    # A pass with no bass-role program still gets the bass line on its lowest voice, and
    # a keys-only pass takes the lead line too: the model should always see a full texture.
    fallback = {"bass": by_role.get("keys") or by_role.get("lead"), "lead": by_role.get("keys") or by_role.get("bass"),
                "keys": by_role.get("lead") or by_role.get("bass")}
    out = []
    for beat, dur, role, pitch in lines:
        instrs = [MELODY_INSTR] if role == "melody" else (by_role.get(role) or fallback[role] or [])
        for instr in instrs:
            out.append((beat * beat_s, dur * beat_s, instr, max(0, min(127, pitch + semis))))
    return out


def chord_pad_events(key, chord, start_s, end_s, beat_s):
    """The window's chord held on PAD_INSTR from PAD_LEAD_BEATS before the window to its end."""
    classes = harmony_classes(key, chord)
    if not classes:
        return []
    onset = max(0.0, start_s - PAD_LEAD_BEATS * beat_s)
    dur = end_s - onset
    # Close voicing in the octave below middle C, root first.
    root = min(classes) if chord is None else _root_class(chord, classes)
    pitches = sorted(48 + ((pc - root) % 12) + root for pc in classes)
    return [(onset, dur, PAD_INSTR, p) for p in pitches]


def _root_class(chord, classes):
    from arrangement import _letter_root
    try:
        return _letter_root(chord) % 12
    except Exception:
        return min(classes)


def build_prompt(history, group, key, genre, chord, start_s, end_s, beat_s):
    """Return (tokens, shift_s): the prompt for one sampling pass and the seconds the live
    timeline was moved later to make room for the prime. Callers add `shift_s` to their
    window bounds and subtract it from every event time the model returns."""
    shift_s = 0.0
    events = []
    if PRIME_ON:
        prime_len_s = (PRIME_BEATS + PRIME_GAP_BEATS) * beat_s
        hist_times = history[::3]
        hist_min_s = (min(hist_times) - TIME_OFFSET) / TIME_RESOLUTION if hist_times else start_s
        # The prime sits right before the retained history, not at time zero: the model's time
        # vocabulary spans 100 s from the prompt's oldest event, so a prime anchored at zero
        # left every window past ~100 s of playing unexpressible (no notes, then NaN in the
        # sampler). Only a session too young for that keeps the old shifted-history layout.
        if hist_min_s >= prime_len_s:
            prime_base_s = hist_min_s - prime_len_s
        else:
            prime_base_s = 0.0
            shift_s = prime_len_s
        events.extend((t + prime_base_s, d, i, p) for (t, d, i, p) in prime_events(genre, key, group, beat_s))
    if CHORD_PAD_ON and chord:
        events.extend((t + shift_s, d, i, p) for (t, d, i, p) in chord_pad_events(key, chord, start_s, end_s, beat_s))
    tokens = []
    for t, d, i, p in sorted(events):
        tokens.extend(make_event(t, d, i, p))
    shifted = list(history)
    if shift_s:
        shifted[::3] = [tok + round(shift_s * TIME_RESOLUTION) for tok in shifted[::3]]
    # History triples are time-sorted to within a bar; the sampler sorts the prompt anyway.
    return tokens + shifted, shift_s
