import unittest
from arrangement import Arranger, role_for_instrument


class ArrangerTests(unittest.TestCase):
    def test_intentional_rest_stays_empty_with_known_harmony(self):
        self.assertEqual(Arranger().arrange([], 0, 4, .5, key='C major', chord='C'), [])

    def test_model_identity_is_preserved_without_added_chords_or_bass(self):
        notes = Arranger(amount=1).arrange([(0, .5, 24, 64)], 0, 2, .5, key='C major')
        self.assertEqual(len(notes), 1)
        self.assertEqual((notes[0]['voice'], notes[0]['gmInstr'], notes[0]['pitch']), ('lead', 24, 64))

    def test_roles_filter_both_generation_and_final_events(self):
        arranger = Arranger(enabled_roles={'keys': False, 'lead': True, 'bass': False})
        self.assertEqual(arranger.generation_instruments((4, 24, 33, 40, 42)), (24,))
        notes = arranger.arrange([(0, 1, 4, 60), (0, 1, 24, 64), (0, 1, 42, 48)], 0, 2, .5)
        self.assertEqual([n['gmInstr'] for n in notes], [24])
        self.assertEqual(role_for_instrument(42), 'bass')

    def test_amount_zero_silences_normal_and_failure_paths(self):
        arranger = Arranger(amount=0)
        self.assertEqual(arranger.generation_instruments((4, 24)), ())
        self.assertEqual(arranger.arrange([(0, 1, 24, 64)], 0, 2, .5), [])
        self.assertEqual(arranger.failure_fallback('C major', 'C', 0, 4, .5), [])

    def test_explicit_failure_fallback_obeys_roles_and_window(self):
        arranger = Arranger(enabled_roles={'keys': False, 'bass': True, 'lead': False})
        notes = arranger.failure_fallback('C major', 'C', 4, 6, .5)
        self.assertTrue(notes)
        self.assertTrue(all(n['voice'] == 'bass' and 4 <= n['beat'] < 6 and n['beat'] + n['dur'] <= 6 for n in notes))

    def test_amount_scales_density_even_at_max_creativity(self):
        raw = [(i * .125, .1, 24, 60 + i % 12) for i in range(32)]
        quiet = Arranger(amount=.1, creativity=1).arrange(raw, 0, 4, .5)
        full = Arranger(amount=1, creativity=1).arrange(raw, 0, 4, .5)
        self.assertLess(len(quiet), len(full))
        self.assertEqual(quiet[0]['vel'], full[0]['vel'])  # client owns immediate amount gain

    def test_independent_instruments_can_answer_together(self):
        notes = Arranger(amount=1).arrange([(0, 1, 24, 60), (0, 1, 4, 64)], 0, 2, .5)
        self.assertEqual(len(notes), 2)
        self.assertTrue(all(n['dur'] > 0 for n in notes))


if __name__ == '__main__':
    unittest.main()
