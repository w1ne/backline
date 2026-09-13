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


def test_sections_change_same_material_without_changing_instrument_identity():
    raw = [(i * .25, .2, instr, pitch) for instr, pitch in [(24, 64), (40, 60), (42, 48)] for i in range(8)]
    outputs = {section: Arranger(amount=1, section=section).arrange(raw, 0, 2, .5)
               for section in ('intro', 'groove', 'lift', 'breakdown', 'ending', 'ended')}
    assert 0 < len(outputs['intro']) < len(outputs['groove']) < len(outputs['lift'])
    assert 0 < len(outputs['breakdown']) < len(outputs['groove'])
    assert {n['gmInstr'] for n in outputs['breakdown']} == {24}
    assert outputs['ended'] == []
    assert all(n['beat'] + n['dur'] <= 1 for n in outputs['ending'])
    assert all(n['gmInstr'] in (24, 40, 42) for out in outputs.values() for n in out)


def test_sections_preserve_a_sparse_selected_instrument_and_never_unmute():
    for section in ('intro', 'groove', 'lift', 'breakdown', 'ending'):
        for instr in (24, 40, 42):
            raw = [(0, .2, instr, 60)]
            assert len(Arranger(section=section).arrange(raw, 0, 1, .5)) == 1
            assert Arranger(amount=0, section=section).arrange(raw, 0, 1, .5) == []
            assert Arranger(section=section, enabled_roles={'keys':False,'bass':False,'lead':False}).arrange(raw, 0, 1, .5) == []


def test_section_spacing_is_anchored_to_beats_across_half_bar_windows():
    arranger = Arranger(amount=1, section='breakdown')
    left = arranger.arrange([(2, .2, 24, 64), (2.5, .2, 24, 67)], 2, 3, .5)
    right = arranger.arrange([(3, .2, 24, 64), (3.5, .2, 24, 67)], 3, 4, .5)
    assert [n['beat'] for n in left + right] == [4, 6]


def test_phrase_rhythm_and_count_do_not_depend_on_creativity():
    from musical_identity import MusicalIdentity
    phrase = [(0, .25, 60), (.25, .25, 64), (.75, .25, 62), (5, .5, 67), (7.5, .5, 65)]
    rhythms = []
    for creativity in (.2, .9, 1):
        identity = MusicalIdentity()
        identity.observe(phrase, {}, 9)
        shaped = identity.shape([(4.5, .2, 24, 64)], 9, 11, .5, 9, creativity, 'lift')
        arranged = Arranger(amount=1, creativity=creativity, section='lift').constrain(
            shaped, 4.5, 5.5, .5, key='C major', chord='C', phrase_instrument=24)
        rhythms.append([(n[0], n[1]) for n in arranged])
    assert rhythms[0] == rhythms[1] == rhythms[2]
    assert len(rhythms[0]) == 3
