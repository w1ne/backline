"""Chord-accuracy bench for the harmony brain: harmonizer alone vs harmonizer + predictor.

Replays a sung arpeggio progression as note events (onset + the browser's ~125 ms detection
latency), decides a chord every half bar, and scores the chord in force the way
bench/voice/output.ts does. Run: python3 bench_harmony.py [--md HARMONY_BENCH.md]
"""
from __future__ import annotations

import argparse
import sys

from harmony import Chord, Key, MelodyHarmonizer, chord_name, tonic_triad
from predict import decide, predict_next

A_MINOR = Key(9, 'minor')
BPM = 90
LATENCY_S = 0.125
BEATS_PER_BAR = 4
HALF_BAR = 2

# Am F C G Am Dm Em Am, one bar each, sung root-third-fifth-third (bench/voice/synth.ts).
ARPEGGIO = [Chord(9, 'min'), Chord(5, 'maj'), Chord(0, 'maj'), Chord(7, 'maj'),
            Chord(9, 'min'), Chord(2, 'min'), Chord(4, 'min'), Chord(9, 'min')]
# A chord held for four bars, then another: what a predictor that always moves on the one costs.
HELD = [Chord(9, 'min')] * 4 + [Chord(5, 'maj')] * 4

SCENARIOS = {'arpeggio-Am-progression': ARPEGGIO, 'held-4-bars-Am-then-F': HELD}


def arpeggio_events(chords: list[Chord], low_midi: int = 55) -> list[tuple[int, float, float]]:
    """(midi, onset_beat, arrival_beat) for root-third-fifth-third per bar, quarter notes."""
    latency_beats = LATENCY_S * BPM / 60
    out = []
    beat = 0.0
    for c in chords:
        third = 4 if c.quality == 'maj' else 3
        root = low_midi + (c.root - low_midi) % 12
        for off in (0, third, 7, third):
            out.append((root + off, beat, beat + latency_beats))
            beat += 1
    return out


def run(chords: list[Chord], use_predictor: bool, lookahead: float = 0.0, genre=None):
    """Chord events [(from_beat, chord, source)] as the service would emit them, one per half bar."""
    h = MelodyHarmonizer(window=HALF_BAR)
    events = arpeggio_events(chords)
    n_beats = len(chords) * BEATS_PER_BAR
    fed = 0
    recent: list[Chord] = []
    out = []
    for tick in range(0, n_beats + 1, HALF_BAR):
        while fed < len(events) and events[fed][2] <= tick:
            midi, _onset, arrival = events[fed]
            h.add_note(midi, arrival)
            fed += 1
        heard = h.tick(tick, A_MINOR)
        if use_predictor:
            reading = h.reading
            chord, source = decide(A_MINOR, genre, reading, recent, reading.coverage,
                                   downbeat=tick % BEATS_PER_BAR == 0)
        else:
            chord, source = heard, 'heard'
        # A plan committed `lookahead` beats ahead: walk the prediction over every downbeat in between.
        target = chord
        t = tick
        while t + HALF_BAR <= tick + lookahead:
            t += HALF_BAR
            if t % BEATS_PER_BAR == 0 and use_predictor:
                target = predict_next(A_MINOR, [target], genre)
                source = 'predicted'
        recent.append(chord)
        recent = recent[-4:]
        out.append((tick + lookahead, target, source))
    return out


def chord_at(events, t: float) -> Chord:
    c = None
    for from_beat, chord, _src in events:
        if from_beat <= t:
            c = chord
        else:
            break
    return c or tonic_triad(A_MINOR)


def score(events, truth: list[Chord]) -> dict:
    n = len(truth)
    hits_start = hits_retro = half_hits = halves = changes = half_changes = 0
    prev = ''
    prev_half = ''
    names = []
    for b, tc in enumerate(truth):
        start = b * BEATS_PER_BAR
        end = start + BEATS_PER_BAR
        at_start = chord_at(events, start + 0.01)
        decided = chord_at(events, end + 0.01)
        names.append(chord_name(at_start))
        if chord_name(at_start) == chord_name(tc):
            hits_start += 1
        if chord_name(decided) == chord_name(tc):
            hits_retro += 1
        if prev and chord_name(at_start) != prev:
            changes += 1
        prev = chord_name(at_start)
        for half in (0, HALF_BAR):
            c = chord_name(chord_at(events, start + half + 0.01))
            halves += 1
            if c == chord_name(tc):
                half_hits += 1
            if prev_half and c != prev_half:
                half_changes += 1
            prev_half = c
    return {
        'bar_start': hits_start / n,
        'half_bar': half_hits / halves,
        'retro': hits_retro / n,
        'changes_per_bar': changes / n,
        'half_changes_per_bar': half_changes / n,
        'names': names,
        'predicted': sum(1 for e in events if e[2] == 'predicted'),
    }


def pct(x: float) -> str:
    return f'{100 * x:.0f}%'


def render(rows) -> str:
    md = ['| scenario | brain | lookahead | bar start = truth | per half bar = truth | decided from the bar = truth | changes / bar (bar starts) | changes / bar (half bars) | predicted decisions |',
          '|---|---|---|---|---|---|---|---|---|']
    for name, brain, lookahead, s in rows:
        md.append(f'| {name} | {brain} | {lookahead:g} beats | {pct(s["bar_start"])} | {pct(s["half_bar"])} | {pct(s["retro"])} | '
                  f'{s["changes_per_bar"]:.2f} | {s["half_changes_per_bar"]:.2f} | {s["predicted"]} |')
    md.append('')
    md.append('Chord in force at each bar start (truth in brackets), lookahead 0:')
    md.append('')
    for name, brain, lookahead, s in rows:
        if lookahead == 0:
            md.append(f'- {name}, {brain}: {" ".join(s["names"])}  ({" ".join(chord_name(c) for c in SCENARIOS[name])})')
    return '\n'.join(md) + '\n'


NOTES = """
## Reading the table

- Harmonizer alone at lookahead 0 reproduces the TS bench: 12% at bar start (TS: 13%), because every tick at a
  downbeat sees only the previous bar (the first note of the new bar arrives 125 ms after the tick).
- With the predictor, bar-start accuracy is 50% (target: above 50%). The chords in force at bar starts are
  `Am F G Em G F Em Am` against `Am F C G Am Dm Em Am`. The three misses:
  - bar 3 (C, predicted G): F -> C is III, weighted 0.2 in the VI row against VII 0.5; the table is the limit.
  - bar 6 (Dm, predicted F): i -> iv is 0.2 against VI 0.3; same.
  - bar 4 (G, got Em): the harmonizer's own reading of E-G-E picked Em over C through the sung-root tie-break
    (a port of the TS behaviour), and a reading that corrects the chord in force wins over the prediction on the
    downbeat. Had the reading been C, the predicted G would have been right.
- "Decided from the bar" is meaningless for the predictor: at the bar-end tick the brain is already committing
  the next bar's chord, so what is in force right after the bar end is a prediction, not a reading of the bar.
- Changes per half bar go up (1.25 vs 1.00): every predicted miss is corrected one half bar later.
- `held-4-bars-Am-then-F` is the cost of predicting: the predictor pushes F on the downbeat of bar 2; the singer
  stays on Am, the reading pulls it back after half a bar, and `rejected()` (a move already pulled back inside the
  last four half bars is not tried again) stops it repeating on bars 3 and 4. 75% vs 88% for the harmonizer alone.
- Lookahead 2 (the plan window starts one half bar after the tick) scores 62% on the arpeggio because the tick
  before a downbeat is mid-bar, where the reading is solid and one step of the table lands the change on the one.
  Lookahead 4 (today's client LOOKAHEAD_BEATS) needs two table steps and falls back to 50%.

## Tuning evidence

`READING_TRUST` 0.75 and `PREDICT_MIN_COVERAGE` 0.5 never decide the bar-start number on this clip: on every
downbeat the half bar is fully covered by the previous chord, so the decision is taken by the downbeat rule
(reading confirms the chord in force -> predict) before either threshold is consulted. Lowering or raising them
changes nothing here; they matter mid-bar when a singer moves early, and the unit tests pin that behaviour.
The lever that moved the number was the downbeat rule plus `rejected()` (held scenario 25% -> 75%).
"""


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--md', help='write the results table to this markdown file')
    ap.add_argument('--genre', default=None)
    args = ap.parse_args(argv)
    rows = []
    for name, truth in SCENARIOS.items():
        for lookahead in (0.0, 2.0, 4.0):
            for brain, use_predictor in (('harmonizer', False), ('harmonizer + predictor', True)):
                events = run(truth, use_predictor, lookahead, args.genre)
                rows.append((name, brain, lookahead, score(events, truth)))
    table = render(rows)
    print(table)
    if args.md:
        header = ('# Harmony bench\n\n'
                  f'`python3 services/amt/bench_harmony.py --md HARMONY_BENCH.md`, {BPM} bpm, quarter-note arpeggios '
                  f'(root-third-fifth-third per bar), {int(LATENCY_S * 1000)} ms detection latency, one decision per half bar. '
                  'Scoring as in bench/voice/output.ts: the chord in force at the bar start, per half bar, and the chord in '
                  'force right after the bar ended (decided from the bar). Lookahead is how far ahead of the tick the plan '
                  'window starts (the client commits with LOOKAHEAD_BEATS 4).\n\n'
                  'The TS bench (bench/voice/OUTPUT.md, harmonizer alone on the synthesized voice) scored 13% at bar start.\n\n')
        with open(args.md, 'w') as f:
            f.write(header + table + NOTES)
    arp = next(s for n, b, la, s in rows if n == 'arpeggio-Am-progression' and b.endswith('predictor') and la == 0)
    print(f'target (bar start above 50% with the predictor, lookahead 0): {pct(arp["bar_start"])} -> '
          + ('met' if arp['bar_start'] > 0.5 else 'not met'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
