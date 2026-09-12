import unittest
from arrangement import shape_notes, bass_pitch


class ArrangementTest(unittest.TestCase):
    def test_overlapping_notes_are_trimmed_in_the_actual_playback_plan(self):
        notes = shape_notes([(2, 5, 60), (2.5, 5, 64), (3, 5, 67)], 2, 4, 0.5, False)
        self.assertEqual(notes, [(2, 0.5, 60), (2.5, 0.5, 64), (3, 1, 67)])

    def test_busy_accompaniment_leaves_more_room_than_gap_answers(self):
        raw = [(i / 8, 2, 60 + i % 5) for i in range(16)]
        support = shape_notes(raw, 0, 2, 0.5, False)
        answer = shape_notes(raw, 0, 2, 0.5, True)
        self.assertLessEqual(len(support), 4)
        self.assertLessEqual(len(answer), 8)
        self.assertLessEqual(answer[-1][0] + answer[-1][1], 1)
        self.assertGreater(support[-1][0], answer[-1][0])
        for notes in (support, answer):
            for current, following in zip(notes, notes[1:]):
                self.assertLessEqual(current[0] + current[1], following[0])
            self.assertLessEqual(notes[-1][0] + notes[-1][1], 2)

    def test_tick_rounded_downbeat_is_kept_at_non_grid_aligned_tempo(self):
        start = 12 * 60 / 133
        end = 16 * 60 / 133
        onset = round(start * 100) / 100
        self.assertLess(onset, start)
        notes = shape_notes([(onset, 0.3, 60)], start, end, 60 / 133, False)
        self.assertEqual(len(notes), 1)
        self.assertAlmostEqual(notes[0][0], start)

    def test_support_stays_in_chord_and_answers_in_key(self):
        raw = [(0, .2, 61), (.5, .2, 66), (1, .2, 70)]
        support = shape_notes(raw, 0, 2, .5, False, key='C major', chord='Dm')
        self.assertTrue(all(p % 12 in {2,5,9} for _,_,p in support))
        answer = shape_notes(raw, 0, 2, .5, True, key='C major', chord='Dm')
        self.assertTrue(all(p % 12 in {0,2,4,5,7,9,11} for _,_,p in answer))
        self.assertLessEqual(max(t+d for t,d,_ in answer), 1)

    def test_instrument_field_passes_through_shaping(self):
        notes = shape_notes([(2, 5, 40, 60), (2.5, 5, 41, 64), (3, 5, 42, 67)], 2, 4, 0.5, False)
        self.assertEqual(notes, [(2, 0.5, 40, 60), (2.5, 0.5, 41, 64), (3, 1, 42, 67)])

    def test_bass_uses_the_players_harmony_in_a_fixed_bass_register(self):
        self.assertEqual(bass_pitch('Dm', 'C major'), 38)
        self.assertEqual(bass_pitch('F#min7', 'C major'), 42)
        self.assertEqual(bass_pitch(None, 'A minor'), 45)
        self.assertIsNone(bass_pitch(None, None))


if __name__ == '__main__':
    unittest.main()
