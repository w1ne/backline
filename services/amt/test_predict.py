import pytest

from harmony import Chord, Key, Reading, chord_name, diatonic_triads
from predict import (
    MAJOR_TABLE, MINOR_TABLE, chord_degree, decide, degree_chord, predict_next, rejected,
    transitions, HEARD, PREDICTED,
)

C_MAJOR = Key(0, 'major')
A_MINOR = Key(9, 'minor')


def reading(chord, pcs=(), key=A_MINOR):
    """A harmonizer reading whose half bar holds one unit of energy on each pitch class in `pcs`."""
    w = [0.0] * 12
    for pc in pcs:
        w[pc % 12] += 1
    return Reading(Chord(*chord), w)


class TestTable:
    @pytest.mark.parametrize('table', [MAJOR_TABLE, MINOR_TABLE])
    def test_every_row_sums_to_one(self, table):
        for deg, row in table.items():
            assert sum(row.values()) == pytest.approx(1.0), deg

    @pytest.mark.parametrize('key', [C_MAJOR, A_MINOR])
    @pytest.mark.parametrize('genre', [None, 'jazz', 'rock', 'lofi', 'unknown'])
    def test_genre_rows_still_sum_to_one_and_stay_diatonic(self, key, genre):
        triads = set(diatonic_triads(key))
        for deg in range(7):
            row = transitions(key, deg, genre)
            if not row:
                continue
            assert sum(row.values()) == pytest.approx(1.0)
            for target in row:
                assert degree_chord(key, target) in triads

    def test_degree_round_trip(self):
        for key in (C_MAJOR, A_MINOR):
            for c in diatonic_triads(key):
                assert degree_chord(key, chord_degree(key, c)) == c
        assert chord_degree(C_MAJOR, Chord(1, 'maj')) is None  # C# is not in C major
        assert chord_degree(C_MAJOR, Chord(0, 'min')) is None  # Cm is not either

    def test_major_argmax(self):
        c = lambda name: {'C': Chord(0), 'Dm': Chord(2, 'min'), 'Em': Chord(4, 'min'), 'F': Chord(5), 'G': Chord(7), 'Am': Chord(9, 'min')}[name]
        assert predict_next(C_MAJOR, [c('C')]) == c('F')
        assert predict_next(C_MAJOR, [c('Dm')]) == c('G')
        assert predict_next(C_MAJOR, [c('Em')]) == c('Am')
        assert predict_next(C_MAJOR, [c('F')]) == c('G')
        assert predict_next(C_MAJOR, [c('G')]) == c('C')
        assert predict_next(C_MAJOR, [c('Am')]) == c('F')

    def test_minor_argmax(self):
        n = lambda ch: chord_name(predict_next(A_MINOR, [ch]))
        assert n(Chord(9, 'min')) == 'F'   # i -> VI (ties with VII, VI listed first)
        assert n(Chord(5, 'maj')) == 'G'   # VI -> VII
        assert n(Chord(7, 'maj')) == 'Am'  # VII -> i
        assert n(Chord(2, 'min')) == 'Em'  # iv -> v
        assert n(Chord(4, 'min')) == 'Am'  # v -> i
        assert n(Chord(0, 'maj')) == 'G'   # III -> VII (ties with VI, VII listed first)

    def test_nothing_recent_or_non_diatonic_predicts_from_the_tonic(self):
        assert predict_next(C_MAJOR, []) == Chord(5, 'maj')  # I -> IV
        assert predict_next(C_MAJOR, [Chord(1, 'maj')]) == Chord(5, 'maj')

    def test_only_the_last_chord_matters(self):
        assert predict_next(C_MAJOR, [Chord(0), Chord(5), Chord(7)]) == Chord(0)


class TestGenre:
    def test_jazz_raises_ii_to_v_and_v_to_i(self):
        plain = transitions(C_MAJOR, 1, None)
        jazz = transitions(C_MAJOR, 1, 'jazz')
        assert jazz[4] > plain[4]
        assert transitions(C_MAJOR, 4, 'jazz')[0] > transitions(C_MAJOR, 4, None)[0]

    def test_rock_raises_iv_and_v_from_i(self):
        plain = transitions(C_MAJOR, 0, None)
        rock = transitions(C_MAJOR, 0, 'rock')
        assert rock[3] > plain[3] and rock[4] > plain[4]
        assert rock[5] < plain[5]
        assert predict_next(C_MAJOR, [Chord(0)], 'rock') in (Chord(5), Chord(7))

    def test_lofi_raises_vi_and_iv(self):
        plain = transitions(C_MAJOR, 0, None)
        lofi = transitions(C_MAJOR, 0, 'lofi')
        assert lofi[5] > plain[5] and lofi[3] > plain[3]
        assert lofi[4] < plain[4]

    def test_unknown_genre_is_plain(self):
        assert transitions(C_MAJOR, 0, 'polka') == transitions(C_MAJOR, 0, None)


class TestDecide:
    def test_confident_reading_wins(self):
        r = reading((0, 'maj'), [0, 4, 7, 4])  # C E G E: the reading covers it all
        chord, source = decide(A_MINOR, None, r, [Chord(9, 'min')], r.coverage)
        assert chord == Chord(0, 'maj') and source == HEARD

    def test_prediction_wins_when_it_fits_half_the_sung_energy(self):
        # Held Am, but the singer moved to F-A: Am covers A only (0.5), prediction F covers both
        r = reading((9, 'min'), [5, 9])
        chord, source = decide(A_MINOR, None, r, [Chord(9, 'min')], r.coverage)
        assert chord == Chord(5, 'maj') and source == PREDICTED

    def test_reading_wins_when_prediction_does_not_fit(self):
        # Held Am, singer on D and B: neither Am (0) nor F (0) fits; stay with the reading
        r = reading((9, 'min'), [2, 11])
        chord, source = decide(A_MINOR, None, r, [Chord(9, 'min')], r.coverage)
        assert chord == Chord(9, 'min') and source == HEARD

    def test_silent_half_bar_keeps_the_reading(self):
        r = reading((9, 'min'), [])
        chord, source = decide(A_MINOR, None, r, [Chord(9, 'min')], r.coverage)
        assert chord == Chord(9, 'min') and source == HEARD

    def test_no_reading_predicts_from_recent(self):
        chord, source = decide(A_MINOR, None, None, [Chord(7, 'maj')], 0.0)
        assert chord == Chord(9, 'min') and source == PREDICTED

    def test_downbeat_with_the_reading_confirming_the_chord_in_force_moves_to_the_prediction(self):
        r = reading((9, 'min'), [4, 0])  # E C: the tail of an Am bar
        chord, source = decide(A_MINOR, None, r, [Chord(7, 'maj'), Chord(9, 'min')], r.coverage, downbeat=True)
        assert chord == Chord(5, 'maj') and source == PREDICTED

    def test_a_move_the_singer_pulled_back_is_not_tried_again(self):
        # the band went Am -> F on a downbeat, the singer stayed on Am and the reading corrected
        # it; the next downbeat keeps Am instead of pushing F again
        r = reading((9, 'min'), [4, 0])
        recent = [Chord(9, 'min'), Chord(5, 'maj'), Chord(9, 'min'), Chord(9, 'min')]
        chord, source = decide(A_MINOR, None, r, recent, r.coverage, downbeat=True)
        assert chord == Chord(9, 'min') and source == HEARD
        assert rejected(Chord(5, 'maj'), Chord(9, 'min'), recent)
        assert not rejected(Chord(5, 'maj'), Chord(9, 'min'), [Chord(5, 'maj'), Chord(7, 'maj'), Chord(9, 'min')][1:])

    def test_downbeat_where_the_reading_corrects_the_chord_in_force_keeps_the_reading(self):
        # the band was on F (predicted) but the singer stayed on Am: the correction wins
        r = reading((9, 'min'), [9, 0, 4, 0])
        chord, source = decide(A_MINOR, None, r, [Chord(9, 'min'), Chord(5, 'maj')], r.coverage, downbeat=True)
        assert chord == Chord(9, 'min') and source == HEARD

    def test_midbar_never_predicts_a_change_the_singer_did_not_make(self):
        r = reading((9, 'min'), [9, 0, 4, 0])
        chord, source = decide(A_MINOR, None, r, [Chord(9, 'min')], r.coverage, downbeat=False)
        assert chord == Chord(9, 'min') and source == HEARD


class TestLearned:
    """data/transitions.json, fitted by fit_transitions.py from Chordonomicon."""

    def test_fitted_matrices_are_small_and_sum_to_one(self):
        import os
        from predict import LEARNED_PATH, learned
        data = learned()
        assert data is not None and os.path.getsize(LEARNED_PATH) < 16_000
        for mode in ('major', 'minor'):
            md = data['modes'][mode]
            assert len(md['degrees']) == 6 and md['transitions'] > 100_000
            for i, row in enumerate(md['first']):
                assert row[i] == 0 and sum(row) == pytest.approx(1.0, abs=2e-3)
            for rows in md['second']:
                for i, row in enumerate(rows):
                    assert row[i] == 0 and sum(row) == pytest.approx(1.0, abs=2e-3)
        for g in data['genre_map'].values():
            assert g in data['genres']

    def test_learned_rows_are_diatonic_and_never_stay(self):
        from predict import learned_first, learned_second
        for key in (C_MAJOR, A_MINOR):
            triads = set(diatonic_triads(key))
            for deg, row in learned_first(key, 'jazz').items():
                assert deg not in row and sum(row.values()) == pytest.approx(1.0, abs=2e-3)
                assert all(degree_chord(key, d) in triads for d in row)
            row = learned_second(key, 4, 0, 'rock')
            assert 0 not in row and sum(row.values()) == pytest.approx(1.0)

    def test_common_moves_are_learned(self):
        from predict import learned_first, learned_second
        major = learned_first(C_MAJOR)
        assert max(major[4], key=major[4].get) == 0        # V -> I
        assert max(major[1], key=major[1].get) == 4        # ii -> V
        minor = learned_first(A_MINOR)
        assert max(minor[6], key=minor[6].get) == 0        # VII -> i
        after_iv_v = learned_second(A_MINOR, 3, 4)
        assert max(after_iv_v, key=after_iv_v.get) == 0    # iv v -> i


class TestHmm:
    def cov(self, key, *pcs):
        from predict import emission_vector
        return emission_vector(reading((0, 'maj'), pcs), key)

    def test_viterbi_follows_clear_evidence_across_a_bar_line(self):
        from predict import viterbi
        am, f = self.cov(A_MINOR, 9, 0, 4), self.cov(A_MINOR, 5, 9, 0)
        # two half bars of Am, then two of F; the last emission ends on a downbeat
        assert viterbi(A_MINOR, None, [am, am, f, f], downbeat=True) == [0, 0, 5, 5]

    def test_viterbi_holds_through_a_silent_half_bar(self):
        from predict import viterbi
        am, silent = self.cov(A_MINOR, 9, 0, 4), [0.0] * 6
        assert viterbi(A_MINOR, None, [am, silent, am, silent]) == [0, 0, 0, 0]

    def test_predict_next_hmm_uses_the_decoded_pair(self):
        from predict import predict_next_hmm
        am, f = self.cov(A_MINOR, 9, 0, 4), self.cov(A_MINOR, 5, 9, 0)
        # decoded Am -> F: the second-order row (i, VI) -> III
        assert predict_next_hmm(A_MINOR, None, [], [am, am, f, f]) == Chord(0, 'maj')
        # only F in view: the first-order VI row -> VII
        assert predict_next_hmm(A_MINOR, None, [], [f, f, f, f]) == Chord(7, 'maj')

    def test_predict_next_hmm_without_emissions_reads_recent_chords(self):
        from predict import predict_next_hmm
        assert predict_next_hmm(C_MAJOR, None, [Chord(2, 'min'), Chord(7)], None) == Chord(0)  # ii V -> I
        assert predict_next_hmm(C_MAJOR, None, [], None) != Chord(0)

    def test_predict_next_hmm_never_returns_the_chord_in_force(self):
        from predict import predict_next_hmm
        for key in (C_MAJOR, A_MINOR):
            for c in diatonic_triads(key):
                assert predict_next_hmm(key, 'rock', [c], None) != c

    def test_hmm_reading_replaces_a_lagging_harmonizer_chord(self):
        from predict import hmm_reading
        am, f = self.cov(A_MINOR, 9, 0, 4), self.cov(A_MINOR, 5, 9, 0)
        r = reading((9, 'min'), [5, 9, 0])
        assert hmm_reading(A_MINOR, None, r, [], [am, am, f, f]).chord == Chord(5, 'maj')

    def test_predict_ahead_walks_the_chain_and_stops_at_a_rejected_push(self):
        from predict import predict_ahead_hmm
        am, f = self.cov(A_MINOR, 9, 0, 4), self.cov(A_MINOR, 5, 9, 0)
        Am, F = Chord(9, 'min'), Chord(5, 'maj')
        # mid-bar on F after Am: one bar line ahead lands on III
        assert predict_ahead_hmm(A_MINOR, None, [Am, F], None, [am, am, f, f], False, F, 1) == Chord(0)
        # the band pushed F off Am and was pulled back: the walk holds Am
        recent = [Am, F, Am, Am]
        sources = [HEARD, PREDICTED, HEARD, HEARD]
        assert predict_ahead_hmm(A_MINOR, None, recent, sources, [am] * 4, True, Am, 1) == Am

    def test_downbeat_predicts_through_a_correction_when_asked(self):
        r = reading((0, 'maj'), [0, 4, 7])  # the decoded bar just ended was C, the band sat on Am
        chord, source = decide(A_MINOR, None, r, [Chord(9, 'min')], r.coverage, downbeat=True,
                               predictor=lambda rc: Chord(7), predict_through_corrections=True)
        assert chord == Chord(7) and source == PREDICTED
        chord, source = decide(A_MINOR, None, r, [Chord(9, 'min')], r.coverage, downbeat=True,
                               predictor=lambda rc: Chord(7))
        assert chord == Chord(0) and source == HEARD


class TestRejectedWithSources:
    def test_only_a_predicted_push_off_the_chord_in_force_counts(self):
        Am, F, G, C = Chord(9, 'min'), Chord(5), Chord(7), Chord(0)
        # pushed F, pulled back to Am: hold, whatever is predicted now
        assert rejected(G, Am, [Am, F, Am, Am], [HEARD, PREDICTED, HEARD, HEARD])
        # the singer went Am -> F -> Am on their own: no push happened
        assert not rejected(F, Am, [Am, F, Am, Am], [HEARD, HEARD, HEARD, HEARD])
        # the band pushed F off C, and the singer answered with Am, not C: not a pull-back
        assert not rejected(F, Am, [C, F, Am, Am], [HEARD, PREDICTED, HEARD, HEARD])
        # a push whose predecessor is out of view cannot be judged
        assert not rejected(F, Am, [F, Am, Am, Am], [PREDICTED, HEARD, HEARD, HEARD])
