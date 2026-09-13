import unittest

try:
    from musical_identity import MusicalIdentity
except ImportError:
    MusicalIdentity = None


PHRASE = [(0, .5, 60), (.5, .5, 64), (1.5, .5, 62), (5, .5, 67), (7.5, .5, 65)]


def records(notes, held=False):
    return {str(i): {'note_index': i, 'beat': b, 'dur': d, 'pitch': p,
                     'held': held, 'confidence': .9} for i, (b, d, p) in enumerate(notes)}


def generated(beat_s=.5, start=9):
    return [(start * beat_s, beat_s, 25, 72), ((start + 1) * beat_s, beat_s, 25, 74),
            (start * beat_s, 4 * beat_s, 33, 40), (start * beat_s, beat_s, 0, 60)]


class MusicalIdentityTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(MusicalIdentity, "MusicalIdentity must implement persistent phrase memory")

    def identity(self, notes=PHRASE):
        self.assertIsNotNone(MusicalIdentity, 'MusicalIdentity must implement persistent phrase memory')
        obj = MusicalIdentity()
        obj.observe(notes, records(notes), 9)
        return obj

    def shape(self, obj, now=9, beat_s=.5, creativity=.2, section='groove', source=None, length=4):
        return obj.shape(generated(beat_s, now) if source is None else source,
                         now, now + length, beat_s, now, creativity, section)

    def test_contrasting_human_hooks_change_same_generated_accompaniment(self):
        a = self.shape(self.identity())
        b = self.shape(self.identity([(t, d, 120 - p) for t, d, p in PHRASE]))
        self.assertNotEqual(a, b)
        self.assertEqual([n for n in a if n[2] != 25], [n for n in generated() if n[2] != 25])
        melody = [n for n in a if n[2] == 25]
        self.assertEqual(len(melody), 3)
        self.assertEqual([p[3] - melody[0][3] for p in melody], [p[2] - 60 for p in PHRASE[:3]])
        self.assertEqual([n[0] for n in melody], [(9 + p[0]) * .5 for p in PHRASE[:3]])
        self.assertAlmostEqual((melody[2][0] - melody[0][0]) / (melody[1][0] - melody[0][0]), 3)
        self.assertLessEqual(max(t + d for t, d, _, _ in melody), 11 * .5)

    def test_two_bar_call_with_final_rest_is_complete(self):
        phrase = [(float(i), .5, 60 + i) for i in range(8)]
        self.assertNotEqual(self.shape(self.identity(phrase)), generated())

    def test_tempo_scaling_is_in_beats(self):
        a = self.shape(self.identity(), beat_s=.5)
        b = self.shape(self.identity(), beat_s=.25)
        self.assertEqual([(t / 2, d / 2, gm, p) for t, d, gm, p in a], b)

    def test_memory_survives_pruned_history(self):
        obj = self.identity()
        obj.observe([], {}, 9)
        self.assertNotEqual(self.shape(obj), generated())

    def test_held_notes_future_notes_and_dense_chords_do_not_make_hooks(self):
        for notes, meta in [(PHRASE, records(PHRASE, True)),
                            ([(t + 20, d, p) for t, d, p in PHRASE], {}),
                            ([(t, d, p + shift) for t, d, p in PHRASE for shift in (0, 4, 7)], {})]:
            with self.subTest(notes=notes):
                obj = MusicalIdentity()
                obj.observe(notes, meta, 9)
                self.assertEqual(self.shape(obj), generated())

    def test_real_release_enables_hook_and_active_note_blocks_answer(self):
        obj = MusicalIdentity()
        obj.observe(PHRASE, records(PHRASE, True), 9)
        obj.observe(PHRASE, records(PHRASE), 9)
        obj.observe(PHRASE + [(8.5, .5, 70)], {**records(PHRASE), 'active': {
            'note_index': 5, 'beat': 8.5, 'dur': .5, 'pitch': 70, 'held': True}}, 9)
        self.assertEqual(self.shape(obj), generated())
        obj.observe(PHRASE, records(PHRASE), 9)
        self.assertNotEqual(self.shape(obj), generated())

    def test_gap_silence_cooldown_and_duplicate_cues(self):
        obj = self.identity()
        self.assertEqual(self.shape(obj, now=8.5), generated(start=8.5))
        first = self.shape(obj)
        self.assertEqual(self.shape(obj), first)
        self.assertEqual(self.shape(obj, now=10), generated(start=10))
        self.assertNotEqual(self.shape(obj, now=17), generated(start=17))
        self.assertEqual(self.shape(obj, now=25), generated(start=25))

    def test_empty_bass_only_short_cues_and_reset_do_not_synthesize(self):
        obj = self.identity()
        self.assertEqual(self.shape(obj, source=[]), [])
        bass = [(4.5, 1, 33, 40), (4.5, 1, 42, 48), (4.5, 1, 128, 36)]
        self.assertEqual(self.shape(obj, source=bass), bass)
        self.assertEqual(self.shape(obj, length=.25), generated())
        obj.reset()
        self.assertEqual(self.shape(obj), generated())

    def test_creativity_and_section_change_transformation_not_note_count(self):
        a = self.shape(self.identity(), creativity=.2)
        b = self.shape(self.identity(), creativity=.9)
        c = self.shape(self.identity(), section='lift')
        self.assertNotEqual(a, b)
        self.assertNotEqual(a, c)
        self.assertEqual(len(a), len(b))
        self.assertEqual(len(a), len(c))

    def test_sounding_legacy_note_blocks_answer_until_its_end(self):
        obj = self.identity()
        obj.observe([(8, 3, 72)], {}, 9)
        self.assertEqual(self.shape(obj), generated())

    def test_extreme_contour_stays_in_midi_range(self):
        phrase = [(t, d, 127 if i % 2 else 0) for i, (t, d, _) in enumerate(PHRASE)]
        output = self.shape(self.identity(phrase), creativity=1)
        self.assertTrue(all(0 <= p <= 127 for _, _, _, p in output))

    def test_response_flag_tracks_each_shape_and_cache(self):
        obj = self.identity()
        self.shape(obj)
        self.assertTrue(obj.response_applied)
        self.shape(obj)
        self.assertTrue(obj.response_applied)
        self.shape(obj, source=[])
        self.assertFalse(obj.response_applied)

    def test_response_instrument_tracks_fresh_cached_and_empty_answers(self):
        obj = self.identity()
        self.assertIsNone(getattr(obj, 'response_instrument', 'missing'))
        self.shape(obj)
        self.assertEqual(obj.response_instrument, 25)
        self.shape(obj)
        self.assertEqual(obj.response_instrument, 25)
        self.shape(obj, source=[])
        self.assertIsNone(obj.response_instrument)
        obj.reset()
        self.assertIsNone(obj.response_instrument)

    def test_dense_two_bar_call_keeps_its_sixteenth_note_rhythm(self):
        phrase = [(i * .25, .2, 60 + i % 5) for i in range(32)]
        obj = self.identity(phrase)
        output = self.shape(obj)
        self.assertEqual([n[0] for n in output if n[2] == 25], [(9 + i*.25)*.5 for i in range(8)])

    def test_late_release_completes_phrase_with_actual_duration(self):
        obj = MusicalIdentity()
        meta = records(PHRASE)
        meta['4']['held'] = True
        obj.observe(PHRASE, meta, 9)
        self.assertEqual(obj.phrase, ())
        released = PHRASE[:-1] + [(7.5, 1.5, 65)]
        obj.observe(released, records(released), 11)
        self.assertEqual(obj.phrase[-1][1], 1.5)
        self.assertNotEqual(self.shape(obj, now=11), generated(start=11))

    def test_old_observation_cannot_clear_currently_held_note(self):
        obj = self.identity()
        obj.observe([(10, 1, 70)], records([(10, 1, 70)], held=True), 11)
        obj.observe(PHRASE, records(PHRASE), 9)
        self.assertEqual(self.shape(obj, now=11), generated(start=11))

    def test_old_cue_cannot_replay_cached_answer_after_newer_cue(self):
        obj = self.identity()
        self.shape(obj)
        self.shape(obj, now=10)
        self.assertEqual(self.shape(obj, now=9), generated(start=9))

    def test_distinct_calls_survive_final_arranger_policy(self):
        from arrangement import Arranger
        arranger = Arranger(amount=.5, creativity=.2)
        a = arranger.constrain(self.shape(self.identity()), 4.5, 6.5, .5)
        b = arranger.constrain(self.shape(self.identity([(t, d, 120-p) for t, d, p in PHRASE])), 4.5, 6.5, .5)
        self.assertNotEqual(a, b)
        self.assertEqual(len([n for n in a if n[2] == 25]), 2)

    def test_non_guitar_melodic_voice_can_answer(self):
        source = [(4.5, .5, 0, 72), (4.5, 2, 33, 40)]
        output = self.shape(self.identity(), source=source)
        self.assertNotEqual(output, source)
        self.assertEqual([n for n in output if n[2] == 33], [source[1]])

    def test_short_phrase_and_low_confidence_do_not_capture(self):
        for notes, meta in [(PHRASE[:3], {}), (PHRASE, {k: {**v, 'confidence': .1} for k, v in records(PHRASE).items()})]:
            obj = MusicalIdentity()
            obj.observe(notes, meta, 9)
            self.assertEqual(self.shape(obj), generated())

    def test_invalid_confidence_is_ignored(self):
        obj = MusicalIdentity()
        meta = {k: {**v, 'confidence': 'unknown'} for k, v in records(PHRASE).items()}
        obj.observe(PHRASE, meta, 9)
        self.assertEqual(self.shape(obj), generated())

    def test_long_released_sustain_is_not_a_phrase(self):
        obj = MusicalIdentity()
        obj.observe([(0, 20, 60)], {}, 21)
        self.assertEqual(self.shape(obj, now=21), generated(start=21))

    def test_creative_transformation_survives_harmony_and_density(self):
        from arrangement import Arranger
        a = Arranger(amount=.5, creativity=.2).constrain(
            self.shape(self.identity(), creativity=.2), 4.5, 6.5, .5, key='C', chord='C')
        b = Arranger(amount=.5, creativity=.9).constrain(
            self.shape(self.identity(), creativity=.9), 4.5, 6.5, .5, key='C', chord='C')
        self.assertNotEqual([n[3] for n in a], [n[3] for n in b])

    def test_storage_bounded_and_repeated_observation_does_not_duplicate(self):
        obj = self.identity()
        for _ in range(10):
            obj.observe(PHRASE, records(PHRASE), 9)
        self.assertEqual(len(obj.phrase), len(PHRASE))
        for beat in range(1000):
            obj.observe([(beat, .25, 60 + beat % 12)], {}, beat + 2)
        self.assertLessEqual(len(obj.pending), 256)
        self.assertLessEqual(len(obj.phrase), 64)


if __name__ == '__main__':
    unittest.main()
