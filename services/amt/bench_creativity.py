"""Bench: how creativity trades off note density and chord/scale tone use.

Run with: python3 bench_creativity.py
Feeds the same seeded windows through shape_notes at creativity 0..1 in
0.1 steps and prints, per creativity value:
  - mean notes per bar (4 beats)
  - share of strong-beat notes that land on chord tones
  - share of off-strong-beat notes that land on a scale (non-chord) tone
"""
import random

from arrangement import shape_notes, harmony_classes

KEY, CHORD = 'C major', 'Am'
BEAT_SECONDS = 0.5
BAR_BEATS = 4.0
WINDOWS = 200


def seeded_windows(seed=20240913, count=WINDOWS):
    rng = random.Random(seed)
    windows = []
    for _ in range(count):
        raw = [(rng.uniform(0, BAR_BEATS * BEAT_SECONDS), rng.uniform(0.1, 0.6), rng.randint(40, 90))
               for _ in range(rng.randint(4, 24))]
        windows.append(raw)
    return windows


def bench_creativity(creativity, windows, chord_tones, scale_tones):
    total_notes = 0
    strong_chord = 0
    strong_total = 0
    passing_scale = 0
    passing_total = 0
    for raw in windows:
        out = shape_notes(raw, 0, BAR_BEATS * BEAT_SECONDS, BEAT_SECONDS, False,
                           key=KEY, chord=CHORD, creativity=creativity, amount=0.8)
        total_notes += len(out)
        for onset, _duration, pitch in out:
            beat = onset / BEAT_SECONDS
            strong = abs(beat % 1) < 1e-6
            pc = pitch % 12
            if strong:
                strong_total += 1
                if pc in chord_tones:
                    strong_chord += 1
            else:
                passing_total += 1
                if pc in scale_tones and pc not in chord_tones:
                    passing_scale += 1
    mean_notes_per_bar = total_notes / len(windows)
    strong_chord_share = strong_chord / strong_total if strong_total else 0.0
    passing_scale_share = passing_scale / passing_total if passing_total else 0.0
    return mean_notes_per_bar, strong_chord_share, passing_scale_share


def main():
    chord_tones = harmony_classes(KEY, CHORD)
    scale_tones = harmony_classes(KEY)
    windows = seeded_windows()

    rows = []
    creativity = 0.0
    while creativity <= 1.0 + 1e-9:
        c = round(creativity, 1)
        mean_notes, strong_chord_share, passing_scale_share = bench_creativity(
            c, windows, chord_tones, scale_tones)
        rows.append((c, mean_notes, strong_chord_share, passing_scale_share))
        creativity += 0.1

    header = f"{'creativity':>10} | {'notes/bar':>10} | {'strong->chord':>14} | {'passing->scale':>15}"
    print(header)
    print('-' * len(header))
    for c, mean_notes, strong_chord_share, passing_scale_share in rows:
        print(f"{c:>10.1f} | {mean_notes:>10.2f} | {strong_chord_share:>14.1%} | {passing_scale_share:>15.1%}")

    return rows


if __name__ == '__main__':
    main()
