"""Port of the harmonizer tests in src/listener/chordDetector.test.ts, one for one."""
import pytest

from harmony import (
    Chord, Key, MelodyHarmonizer, chord_name, chord_tones, diatonic_triads,
    harmonize_melody, parse_key, pitch_class_weights, tonic_triad,
)

C_MAJOR = Key(0, 'major')
A_MINOR = Key(9, 'minor')
WINDOW = 1.0


def note(midi, t, weight=1.0):
    return (midi, t, weight)


class TestPitchClassWeights:
    def test_fades_notes_out_over_the_window_and_drops_them_past_its_edge(self):
        w = pitch_class_weights([note(60, 0), note(62, 0.5), note(64, -1)], 1, WINDOW)
        assert w[0] == pytest.approx(0, abs=1e-5)  # exactly one window old: gone
        assert w[2] == pytest.approx(0.5, abs=1e-5)
        assert w[4] == 0  # before the window entirely

    def test_weights_bass_notes_higher(self):
        low = pitch_class_weights([note(36, 0)], 0, WINDOW)
        high = pitch_class_weights([note(72, 0)], 0, WINDOW)
        assert low[0] == pytest.approx(high[0] * 1.5, abs=1e-5)

    def test_no_fade_keeps_full_weight(self):
        w = pitch_class_weights([note(60, 0)], 0.9, WINDOW, fade=False)
        assert w[0] == 1


class TestChordName:
    def test_names_every_quality(self):
        names = [chord_name(Chord(9, q)) for q in ['maj', 'min', 'dom7', 'min7', 'maj7', 'sus4', 'dim']]
        assert names == ['A', 'Am', 'A7', 'Am7', 'Amaj7', 'Asus4', 'Adim']

    def test_sharps_and_wraparound(self):
        assert chord_name(Chord(1, 'maj')) == 'C#'
        assert chord_name(Chord(13, 'min')) == 'C#m'
        assert chord_name(Chord(-1, 'maj')) == 'B'


class TestDiatonicTriads:
    def test_major_order_is_tonic_then_harmonic_weight(self):
        assert [chord_name(c) for c in diatonic_triads(C_MAJOR)] == ['C', 'G', 'F', 'Am', 'Dm', 'Em']

    def test_minor_order_is_tonic_then_harmonic_weight(self):
        assert [chord_name(c) for c in diatonic_triads(A_MINOR)] == ['Am', 'Em', 'F', 'Dm', 'G', 'C']

    def test_tonic_triad(self):
        assert tonic_triad(A_MINOR) == Chord(9, 'min')
        assert tonic_triad(C_MAJOR) == Chord(0, 'maj')
        assert chord_tones(Chord(9, 'min')) == [9, 0, 4]


class TestHarmonizeMelody:
    def test_nothing_sung_is_tonic_or_held(self):
        assert harmonize_melody([0] * 12, A_MINOR, None) == Chord(9, 'min')
        assert harmonize_melody([0] * 12, A_MINOR, Chord(5, 'maj')) == Chord(5, 'maj')

    def test_below_min_coverage_keeps_held(self):
        w = [1.0] * 12  # every pitch class: no triad covers half
        assert harmonize_melody(w, A_MINOR, Chord(7, 'maj')) == Chord(7, 'maj')
        assert harmonize_melody(w, A_MINOR, None) == Chord(9, 'min')

    def test_rival_needs_switch_margin(self):
        w = [0.0] * 12
        w[9] = 1; w[0] = 1; w[4] = 1
        w[7] = 0.5
        held = Chord(9, 'min')
        # coverage Am = 3/3.5 = .857, C = 2.5/3.5 = .714: Am stays
        assert harmonize_melody(w, A_MINOR, held) == held
        w[9] = 0.2
        # Am = 2.2/2.7 = .815, C = 2.5/2.7 = .926: margin .11 < .15, still held
        assert harmonize_melody(w, A_MINOR, held) == held
        w[9] = 0
        # Am = 2/2.5 = .8, C = 1.0: margin .2, switch
        assert harmonize_melody(w, A_MINOR, held) == Chord(0, 'maj')


class TestMelodyHarmonizerSingleVoice:
    """ChordDetector melody harmonizer (single voice)."""

    def test_harmonizes_two_sung_notes_with_the_diatonic_triad_that_holds_both(self):
        h = MelodyHarmonizer(window=1.33)
        h.add_note(67, 0.2, 0.8)  # G
        h.add_note(71, 0.8, 0.8)  # B
        assert h.tick(1.3, A_MINOR) == Chord(7, 'maj')  # G major

    def test_holds_the_current_chord_when_the_next_note_still_fits_it(self):
        h = MelodyHarmonizer(window=1.33)
        h.add_note(57, 0.2, 0.8); h.add_note(60, 0.8, 0.8)  # A C -> Am
        assert h.tick(1.3, A_MINOR) == Chord(9, 'min')
        h.add_note(64, 1.5, 0.8)  # E fits Am (and C) -> stay on Am
        assert h.tick(2.6, A_MINOR) == Chord(9, 'min')

    def test_sits_on_the_tonic_while_nothing_has_been_sung(self):
        h = MelodyHarmonizer()
        assert h.tick(1, A_MINOR) == Chord(9, 'min')

    def test_prefers_the_tonic_over_a_rival_that_covers_a_lone_sung_note_equally_well(self):
        h = MelodyHarmonizer(window=1.33)
        h.add_note(64, 0.5, 0.8)  # E alone: Am, C and Em all hold it
        assert h.tick(1.3, A_MINOR) == Chord(9, 'min')

    def test_never_uses_triad_templates_even_when_three_pitch_classes_linger(self):
        h = MelodyHarmonizer(window=1.33)
        h.add_note(69, 0.0, 0.8)  # A, tail of the previous bar
        h.add_note(60, 0.7, 0.8); h.add_note(64, 1.3, 0.8); h.add_note(67, 1.9, 0.8)  # C E G
        assert h.tick(2.0, A_MINOR) == Chord(0, 'maj')

    def test_no_key_returns_none(self):
        h = MelodyHarmonizer()
        h.add_note(60, 0)
        assert h.tick(0.5, None) is None

    def test_follows_c_then_f_then_g_one_chord_per_bar_without_flicker(self):
        h = MelodyHarmonizer(window=2.0)  # two beats
        seen = []
        t = 0.0
        for triad in ([60, 64, 67], [65, 69, 72], [67, 71, 74]):
            for _half in range(2):
                for i in range(4):
                    h.add_note(triad[i % 3], t)
                    t += 0.5
                seen.append(chord_name(h.tick(t, C_MAJOR)))
        assert seen == ['C', 'C', 'F', 'F', 'G', 'G']

    def test_reading_exposes_coverage_of_the_current_half_bar(self):
        h = MelodyHarmonizer(window=2.0)
        for i, m in enumerate([60, 64, 67, 64]):
            h.add_note(m, i * 0.5)
        h.tick(2.0, C_MAJOR)
        r = h.reading
        assert r.chord == Chord(0, 'maj')
        assert r.coverage == pytest.approx(1.0)
        assert r.half_bar_coverage(Chord(9, 'min')) < 1.0

    def test_reset_forgets_notes_and_held_chord(self):
        h = MelodyHarmonizer(window=1.33)
        h.add_note(67, 0.2, 0.8); h.add_note(71, 0.8, 0.8)
        assert h.tick(1.3, A_MINOR) == Chord(7, 'maj')
        h.reset()
        assert h.tick(1.3, A_MINOR) == Chord(9, 'min')


class TestParseKey:
    def test_wire_format_from_the_client(self):
        assert parse_key('A minor') == Key(9, 'minor')
        assert parse_key('C# major') == Key(1, 'major')
        assert parse_key('Bb major') == Key(10, 'major')
        assert parse_key(None) is None
        assert parse_key('nonsense') is None
