"""Fit diatonic-degree chord transition matrices from the Chordonomicon corpus (build time).

    python3 fit_transitions.py [--csv chordonomicon_v2.csv] [--out data/transitions.json]

Without --csv the 264 MB CSV is streamed from Hugging Face (no login):
https://huggingface.co/datasets/ailsntua/Chordonomicon (CC BY-NC 4.0; Kantarelis et al. 2024,
arXiv:2410.22046). The corpus itself is never committed; only the fitted counts are, as a
few-KB JSON read by predict.py.

Per song: parse the chord tokens, pick the key whose six diatonic triads (I ii iii IV V vi /
i III iv v VI VII) explain the most chords -- relative major and minor share the set, so the
mode is decided by which tonic opens sections, starts and ends the song, and occurs more --
map chords to degrees, collapse repeats, and count first-order (6x6) and second-order (6x6x6)
transitions per mode, with add-0.5 smoothing. First-order counts are also kept per
Chordonomicon `main_genre` for the genres the client offers (GENRE_MAP).
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
import urllib.request
from collections import Counter, defaultdict

CSV_URL = 'https://huggingface.co/datasets/ailsntua/Chordonomicon/resolve/main/chordonomicon_v2.csv'
LICENSE = 'CC BY-NC 4.0'

# Client genre -> Chordonomicon main_genre. lofi borrows jazz harmony; funk has no bucket of its
# own (soul's minor rows prefer i -> VII and cost the arpeggio bench 12 points), so it uses the
# mode rows.
GENRE_MAP = {'jazz': 'jazz', 'rock': 'rock', 'lofi': 'jazz', 'pop': 'pop'}
# Genre rows are shrunk toward the mode row by this many pseudo-transitions per row: the small
# genre jazz (~4k songs) would otherwise carry sampling noise into the live decision.
GENRE_SHRINK = 10000

MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11]
MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10]
# The six triads the band sits on, by 0-based scale degree; the diminished one is left out.
MAJOR_DEGREES = [0, 1, 2, 3, 4, 5]
MINOR_DEGREES = [0, 2, 3, 4, 5, 6]
SMOOTHING = 0.5
MIN_CHORDS = 8
MIN_DIATONIC = 0.85

_LETTER = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}
_TOKEN = re.compile(r'^([A-G])(s|b)?(.*)$')


def parse_chord(tok: str):
    """(pitch_class, 'maj'|'min') or None for chords outside the two triad qualities."""
    m = _TOKEN.match(tok)
    if not m:
        return None
    pc = (_LETTER[m[1]] + {'s': 1, 'b': -1, None: 0}[m[2]]) % 12
    rest = m[3].split('/')[0]
    if 'dim' in rest or 'aug' in rest or 'no3' in rest or 'sus' in rest:
        return None
    return pc, ('min' if rest.startswith('min') else 'maj')


def triads(root: int, mode: str) -> dict[tuple[int, str], int]:
    """{(pc, quality): degree} for the six triads of the key."""
    scale = MAJOR_SCALE if mode == 'major' else MINOR_SCALE
    degs = MAJOR_DEGREES if mode == 'major' else MINOR_DEGREES
    out = {}
    for d in degs:
        pc = (root + scale[d]) % 12
        third = (scale[(d + 2) % 7] - scale[d]) % 12
        out[(pc, 'maj' if third == 4 else 'min')] = d
    return out


TRIADS = {(r, m): triads(r, m) for r in range(12) for m in ('major', 'minor')}


def estimate_key(chords, section_starts):
    """(root, mode) or None when no key's six triads cover MIN_DIATONIC of the chords.

    `chords` are (pc, quality) pairs, `section_starts` indices into it.
    """
    best, best_cov = None, 0.0
    for root in range(12):
        t = TRIADS[(root, 'major')]
        cov = sum(1 for c in chords if c in t) / len(chords)
        if cov > best_cov:
            best, best_cov = root, cov
    if best is None or best_cov < MIN_DIATONIC:
        return None
    maj, rel = (best, 'maj'), ((best + 9) % 12, 'min')

    def tonic_score(t):
        return (2.0 * (chords[0] == t) + 2.0 * (chords[-1] == t)
                + sum(1.0 for i in section_starts if chords[i] == t)
                + 0.25 * sum(1 for c in chords if c == t))
    return (best, 'major') if tonic_score(maj) >= tonic_score(rel) else ((best + 9) % 12, 'minor')


def song_degrees(row_chords: str):
    """(mode, degree sequence with repeats collapsed, None where the chain breaks) or None."""
    chords, section_starts = [], []
    for tok in row_chords.split():
        if tok.startswith('<'):
            section_starts.append(len(chords))
            continue
        chords.append(parse_chord(tok))
    known = [c for c in chords if c is not None]
    if len(known) < MIN_CHORDS:
        return None
    # indices into `known` of the chords that open a section
    pos = {}
    k = 0
    for i, c in enumerate(chords):
        if c is not None:
            pos[i] = k
            k += 1
    starts = [pos[i] for i in section_starts if i in pos]
    key = estimate_key(known, starts)
    if key is None:
        return None
    t = TRIADS[key]
    seq = []
    for c in chords:
        d = t.get(c) if c is not None else None
        if d is None:
            seq.append(None)
        elif not seq or seq[-1] != d:
            seq.append(d)
    return key[1], seq


def smoothed(counts, n_states):
    """Rows of add-SMOOTHING probabilities over the degree index; self-transitions never occur
    (repeats are collapsed) and stay at zero."""
    rows = []
    for i in range(n_states):
        row = [counts.get((i, j), 0) + (SMOOTHING if i != j else 0.0) for j in range(n_states)]
        total = sum(row)
        rows.append([round(v / total, 4) for v in row])
    return rows


def shrunk(counts, base_rows, n_states):
    """Genre rows: (count + GENRE_SHRINK * mode probability) / (row total + GENRE_SHRINK)."""
    rows = []
    for i in range(n_states):
        row = [counts.get((i, j), 0) + GENRE_SHRINK * base_rows[i][j] for j in range(n_states)]
        total = sum(row)
        rows.append([round(v / total, 4) for v in row])
    return rows


def smoothed2(counts, n_states):
    return [smoothed({(b, c): n for (a, b, c), n in counts.items() if a == p}, n_states)
            for p in range(n_states)]


def fit(rows):
    first = {'major': Counter(), 'minor': Counter()}
    second = {'major': Counter(), 'minor': Counter()}
    genre_first = defaultdict(lambda: {'major': Counter(), 'minor': Counter()})
    songs = Counter()
    wanted = set(GENRE_MAP.values())
    for row in rows:
        r = song_degrees(row['chords'])
        if r is None:
            songs['skipped'] += 1
            continue
        mode, seq = r
        degs = MAJOR_DEGREES if mode == 'major' else MINOR_DEGREES
        idx = [None if d is None else degs.index(d) for d in seq]
        songs[mode] += 1
        genre = (row.get('main_genre') or '').strip()
        gf = genre_first[genre][mode] if genre in wanted else None
        if gf is not None:
            songs['genre:' + genre] += 1
        for a, b in zip(idx, idx[1:]):
            if a is None or b is None:
                continue
            first[mode][(a, b)] += 1
            if gf is not None:
                gf[(a, b)] += 1
        for a, b, c in zip(idx, idx[1:], idx[2:]):
            if None in (a, b, c):
                continue
            second[mode][(a, b, c)] += 1
    out = {
        'source': 'Chordonomicon v2 (ailsntua/Chordonomicon on Hugging Face), ' + LICENSE,
        'smoothing': SMOOTHING,
        'songs': dict(songs),
        'modes': {},
        'genres': {},
        'genre_map': GENRE_MAP,
    }
    for mode, degs in (('major', MAJOR_DEGREES), ('minor', MINOR_DEGREES)):
        out['modes'][mode] = {
            'degrees': degs,
            'first': smoothed(first[mode], 6),
            'second': smoothed2(second[mode], 6),
            'transitions': sum(first[mode].values()),
        }
    for genre, per_mode in genre_first.items():
        out['genres'][genre] = {mode: shrunk(per_mode[mode], out['modes'][mode]['first'], 6)
                                for mode in ('major', 'minor')}
    return out


def open_rows(path):
    if path:
        return csv.DictReader(open(path, newline='', encoding='utf-8'))
    req = urllib.request.Request(CSV_URL, headers={'User-Agent': 'backline-fit-transitions'})
    return csv.DictReader(io.TextIOWrapper(urllib.request.urlopen(req), encoding='utf-8', newline=''))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--csv', help='local copy of chordonomicon_v2.csv (default: stream from Hugging Face)')
    ap.add_argument('--out', default='data/transitions.json')
    ap.add_argument('--limit', type=int, default=0, help='only the first N songs (smoke runs)')
    args = ap.parse_args(argv)
    rows = open_rows(args.csv)
    if args.limit:
        rows = (r for _, r in zip(range(args.limit), rows))
    out = fit(rows)
    with open(args.out, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    print(json.dumps(out['songs']), '->', args.out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
