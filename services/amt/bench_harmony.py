"""Chord-accuracy bench for the harmony brain: harmonizer alone vs harmonizer + table predictor
vs harmonizer + learned HMM predictor.

Replays a sung arpeggio progression as note events (onset + the browser's ~125 ms detection
latency), decides a chord every half bar, and scores the chord in force the way
bench/voice/output.ts does. Run: python3 bench_harmony.py [--md HARMONY_BENCH.md] [--tune]
"""
from __future__ import annotations

import argparse
import sys

import predict
from harmony import Chord, Key, MelodyHarmonizer, chord_name, tonic_triad
from predict import decide, emission_vector, hmm_reading, predict_ahead_hmm, predict_next, predict_next_hmm

A_MINOR = Key(9, 'minor')
C_MAJOR = Key(0, 'major')
BPM = 90
LATENCY_S = 0.125
BEATS_PER_BAR = 4
HALF_BAR = 2

Am, Dm, Em, F, C, G = Chord(9, 'min'), Chord(2, 'min'), Chord(4, 'min'), Chord(5), Chord(0), Chord(7)

# Am F C G Am Dm Em Am, one bar each, sung root-third-fifth-third (bench/voice/synth.ts).
ARPEGGIO = [Am, F, C, G, Am, Dm, Em, Am]
# A chord held for four bars, then another: what a predictor that always moves on the one costs.
HELD = [Am] * 4 + [F] * 4
# The pop loop I V vi IV in C major, twice.
POP_LOOP = [C, G, Am, F] * 2
# i VII VI VII in A minor, twice.
MINOR_LOOP = [Am, G, F, G] * 2

SCENARIOS: dict[str, tuple[Key, list[Chord]]] = {
    'arpeggio-Am-progression': (A_MINOR, ARPEGGIO),
    'held-4-bars-Am-then-F': (A_MINOR, HELD),
    'pop-loop-C-I-V-vi-IV': (C_MAJOR, POP_LOOP),
    'minor-loop-Am-i-VII-VI-VII': (A_MINOR, MINOR_LOOP),
}

BRAINS = {'harmonizer': None, 'harmonizer + table': 'table', 'harmonizer + hmm': 'hmm'}


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



def run(chords: list[Chord], use_predictor, lookahead: float = 0.0, genre=None, key: Key = A_MINOR,
        alpha: float = predict.EMISSION_ALPHA):
    """Chord events [(from_beat, chord, source)] as the service would emit them, one per half bar.

    `use_predictor`: None/False for the harmonizer alone, 'table' (or True) for the hand-written
    table, 'hmm' for the learned transitions + Viterbi.
    """
    method = {True: 'table', False: None}.get(use_predictor, use_predictor)
    h = MelodyHarmonizer(window=HALF_BAR)
    events = arpeggio_events(chords)
    n_beats = len(chords) * BEATS_PER_BAR
    fed = 0
    recent: list[Chord] = []
    sources: list[str] = []
    emissions: list[list[float]] = []
    out = []
    for tick in range(0, n_beats + 1, HALF_BAR):
        while fed < len(events) and events[fed][2] <= tick:
            midi, _onset, arrival = events[fed]
            h.add_note(midi, arrival)
            fed += 1
        heard = h.tick(tick, key)
        reading = h.reading
        emissions = (emissions + [emission_vector(reading, key)])[-predict.HMM_WINDOW:]
        downbeat = tick % BEATS_PER_BAR == 0
        if method == 'hmm':
            hr = hmm_reading(key, genre, reading, recent, emissions, alpha, downbeat)
            chord, source = decide(key, genre, hr, recent, hr.coverage, downbeat=downbeat, sources=sources,
                                   predictor=lambda rc: predict_next_hmm(key, genre, rc, emissions, alpha, downbeat),
                                   predict_through_corrections=True)
        elif method:
            chord, source = decide(key, genre, reading, recent, reading.coverage, downbeat=downbeat, sources=sources,
                                   predictor=lambda rc: predict_next(key, rc, genre))
        else:
            chord, source = heard, 'heard'
        sources = (sources + [source])[-predict.RECENT_HALF_BARS:]
        recent = (recent + [chord])[-predict.RECENT_HALF_BARS:]
        # A plan committed `lookahead` beats ahead: walk the prediction over every downbeat in between.
        downbeats_ahead = sum(1 for t in range(tick + HALF_BAR, tick + int(lookahead) + 1, HALF_BAR)
                              if t % BEATS_PER_BAR == 0)
        target = chord
        if method and downbeats_ahead:
            source = 'predicted'
            if method == 'hmm':
                target = predict_ahead_hmm(key, genre, recent, sources, emissions, downbeat, chord, downbeats_ahead)
            else:
                for _ in range(downbeats_ahead):
                    target = predict_next(key, [target], genre)
        out.append((tick + lookahead, target, source))
    return out


def chord_at(events, t: float, key: Key = A_MINOR) -> Chord:
    c = None
    for from_beat, chord, _src in events:
        if from_beat <= t:
            c = chord
        else:
            break
    return c or tonic_triad(key)


def score(events, truth: list[Chord], key: Key = A_MINOR) -> dict:
    n = len(truth)
    hits_start = hits_retro = half_hits = halves = changes = half_changes = 0
    prev = ''
    prev_half = ''
    names = []
    for b, tc in enumerate(truth):
        start = b * BEATS_PER_BAR
        end = start + BEATS_PER_BAR
        at_start = chord_at(events, start + 0.01, key)
        decided = chord_at(events, end + 0.01, key)
        names.append(chord_name(at_start))
        if chord_name(at_start) == chord_name(tc):
            hits_start += 1
        if chord_name(decided) == chord_name(tc):
            hits_retro += 1
        if prev and chord_name(at_start) != prev:
            changes += 1
        prev = chord_name(at_start)
        for half in (0, HALF_BAR):
            c = chord_name(chord_at(events, start + half + 0.01, key))
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


def bench(genre=None, alpha: float = predict.EMISSION_ALPHA, lookaheads=(0.0, 2.0, 4.0)):
    rows = []
    for name, (key, truth) in SCENARIOS.items():
        for lookahead in lookaheads:
            for brain, method in BRAINS.items():
                events = run(truth, method, lookahead, genre, key, alpha)
                rows.append((name, brain, lookahead, score(events, truth, key)))
    return rows


def summary(rows, lookahead: float = 0.0) -> dict[str, dict[str, float]]:
    """{brain: {scenario: bar_start}} plus the 'mean' over scenarios, at one lookahead."""
    out: dict[str, dict[str, float]] = {}
    for name, brain, la, s in rows:
        if la == lookahead:
            out.setdefault(brain, {})[name] = s['bar_start']
    for brain, per in out.items():
        per['mean'] = sum(per.values()) / len(per)
    return out


def render(rows) -> str:
    md = ['| scenario | brain | lookahead | bar start = truth | per half bar = truth | decided from the bar = truth | changes / bar (bar starts) | changes / bar (half bars) | predicted decisions |',
          '|---|---|---|---|---|---|---|---|---|']
    for name, brain, lookahead, s in rows:
        md.append(f'| {name} | {brain} | {lookahead:g} beats | {pct(s["bar_start"])} | {pct(s["half_bar"])} | {pct(s["retro"])} | '
                  f'{s["changes_per_bar"]:.2f} | {s["half_changes_per_bar"]:.2f} | {s["predicted"]} |')
    md.append('')
    lookaheads = sorted({la for _, _, la, _ in rows})
    md.append('Bar-start accuracy, table vs hmm, per lookahead (lookahead 2 is the client setting):')
    md.append('')
    md.append('| scenario | ' + ' | '.join(f'harmonizer @{la:g} | table @{la:g} | hmm @{la:g}' for la in lookaheads) + ' |')
    md.append('|---|' + '---|---|---|' * len(lookaheads))
    summs = {la: summary(rows, la) for la in lookaheads}
    for name in list(SCENARIOS) + ['mean']:
        cells = []
        for la in lookaheads:
            s = summs[la]
            cells.append(f'{pct(s["harmonizer"][name])} | {pct(s["harmonizer + table"][name])} | {pct(s["harmonizer + hmm"][name])}')
        md.append(f'| {name} | ' + ' | '.join(cells) + ' |')
    md.append('')
    md.append('Chord in force at each bar start (truth in brackets), lookahead 0:')
    md.append('')
    for name, brain, lookahead, s in rows:
        if lookahead == 0:
            md.append(f'- {name}, {brain}: {" ".join(s["names"])}  ({" ".join(chord_name(c) for c in SCENARIOS[name][1])})')
    return '\n'.join(md) + '\n'


def render_tuning(genre=None) -> str:
    md = ['| alpha | ' + ' | '.join(SCENARIOS) + ' | mean |', '|---|' + '---|' * (len(SCENARIOS) + 1)]
    for alpha in (0.5, 0.75, 1.0, 1.5, 2.0):
        summ = summary(bench(genre, alpha, lookaheads=(0.0,)))['harmonizer + hmm']
        md.append(f'| {alpha:g} | ' + ' | '.join(pct(summ[n]) for n in SCENARIOS) + f' | {pct(summ["mean"])} |')
    return '\n'.join(md) + '\n'


NOTES = """
## Reading the table

- Harmonizer alone at lookahead 0 reproduces the TS bench: 12% at bar start on the arpeggio (TS: 13%), because
  every tick at a downbeat sees only the previous bar (the first note of the new bar arrives 125 ms after the tick).
- `table` is the hand-written first-order table (MAJOR_TABLE / MINOR_TABLE in predict.py). Its arpeggio misses:
  F -> C (III weighted 0.2 against VII 0.5), i -> iv (0.2 against VI 0.3), and bar 4 where the harmonizer's own
  E-G-E reading picked Em over C and a reading that corrects the chord in force wins over the prediction.
- `hmm` is `predict_next_hmm`: degree transitions fitted on Chordonomicon (fit_transitions.py: 468k songs after key
  estimation, first- and second-order counts per mode with add-0.5 smoothing, first-order rows per genre for
  jazz/rock/pop shrunk toward the mode row), a Viterbi decode of the last four half-bar coverage vectors (stay
  probability 0.35 across a bar line, 0.85 mid-bar; emission coverage^alpha with a 1.5x root-sung bonus) that
  replaces the harmonizer's lagging reading with the chord the singer is decoded on, then the argmax of the
  second-order row from the decoded (previous, current) pair. On a downbeat it predicts even when the decoded bar
  corrects the chord in force: the coming bar is more likely a step on from the decoded chord than a late copy
  of it. `brain.py` uses it by default (PREDICTOR = 'hmm').
- The arpeggio's remaining hmm misses are corpus preferences, not decode errors: i -> VI (0.34) over i -> iv
  (0.10) at bar 5, and (i, iv) -> i over (i, iv) -> v at bar 6. The minor loop loses the same way: (VI, VII) -> i
  outweighs VII -> VI on every second pass, and i -> VI outweighs i -> VII.
- "Decided from the bar" is meaningless for either predictor: at the bar-end tick the brain is already committing
  the next bar's chord, so what is in force right after the bar end is a prediction, not a reading of the bar.
- `held-4-bars-Am-then-F` is the cost of predicting: a predictor pushes a change on the downbeat of bar 2; the
  singer stays on Am, the reading pulls it back after half a bar, and `rejected()` (a PREDICTED push off the chord
  in force that the singer pulled back inside the last six half bars blocks every move) stops it repeating on
  bars 3 and 4. Both predictors pay one bar for the push and one for the change to F a bar late.
- Lookahead 2 is the client's setting (LOOKAHEAD_BEATS in amtEngine.ts). The tick before a downbeat is mid-bar,
  so the decode has only one half bar of the current chord; the hmm walks from the decoded pair with
  `predict_ahead_hmm` and stops at a rejected push, which is what lifts the held scenario from 25% to 62%.

## Tuning evidence

`READING_TRUST` 0.75 and `PREDICT_MIN_COVERAGE` 0.5 never decide the bar-start number on these clips: on every
downbeat the half bar is fully covered by the previous chord, so the decision is taken by the downbeat rule
before either threshold is consulted. They matter mid-bar when a singer moves early, and the unit tests pin that.

Stay probabilities 0.25/0.75 cost the held scenario (38%); 0.5/0.9 cost the arpeggio (50%). The 1.5x root bonus
is what separates Dm from F and C from Am on two-note half bars; without it the arpeggio is 62% and the pop loop
75% at lookahead 0 but lookahead 2 drops to 53%. Genre rows are used only for the step forward, never inside the
decode: the decode identifies, the genre steps. A soft (posterior-weighted) mid-bar step was tried and dropped:
same mean, and the jazz/lofi rows made it flip close calls.

`EMISSION_ALPHA` sweep (hmm, bar-start accuracy, lookahead 0; `python3 bench_harmony.py --tune`):

"""


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--md', help='write the results table to this markdown file')
    ap.add_argument('--genre', default=None)
    ap.add_argument('--tune', action='store_true', help='sweep EMISSION_ALPHA for the hmm predictor')
    ap.add_argument('--alpha', type=float, default=predict.EMISSION_ALPHA)
    args = ap.parse_args(argv)
    rows = bench(args.genre, args.alpha)
    table = render(rows)
    print(table)
    tuning = render_tuning(args.genre) if (args.tune or args.md) else ''
    if tuning:
        print('EMISSION_ALPHA sweep (hmm, bar start, lookahead 0):')
        print(tuning)
    if args.md:
        header = ('# Harmony bench\n\n'
                  f'`python3 services/amt/bench_harmony.py --md HARMONY_BENCH.md`, {BPM} bpm, quarter-note arpeggios '
                  f'(root-third-fifth-third per bar), {int(LATENCY_S * 1000)} ms detection latency, one decision per half bar. '
                  'Scoring as in bench/voice/output.ts: the chord in force at the bar start, per half bar, and the chord in '
                  'force right after the bar ended (decided from the bar). Lookahead is how far ahead of the tick the plan '
                  'window starts (the client commits with LOOKAHEAD_BEATS 2, src/engines/amtEngine.ts).\n\n'
                  'The TS bench (bench/voice/OUTPUT.md, harmonizer alone on the synthesized voice) scored 13% at bar start.\n\n')
        with open(args.md, 'w') as f:
            f.write(header + table + NOTES + tuning)
    summ = summary(rows)
    table_s, hmm_s = summ['harmonizer + table'], summ['harmonizer + hmm']
    worse = [n for n in SCENARIOS if hmm_s[n] < table_s[n]]
    print(f'target (hmm bar start, lookahead 0: mean >= 60%, no scenario below the table): '
          f'mean {pct(hmm_s["mean"])} vs table {pct(table_s["mean"])}, below table: {worse or "none"} -> '
          + ('met' if hmm_s['mean'] >= 0.6 and not worse else 'not met'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
