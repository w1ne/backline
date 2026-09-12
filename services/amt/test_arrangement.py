import unittest
from arrangement import fill_silent_window, shape_notes, bass_pitch, voice_chord, harmony_classes, early_entry_plan


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

    def test_amount_controls_density_and_zero_is_silent(self):
        raw = [(i * .125, .4, 60 + i % 8) for i in range(32)]
        quiet = shape_notes(raw, 0, 4, .5, False, amount=.1)
        full = shape_notes(raw, 0, 4, .5, False, amount=1)
        self.assertGreater(len(full), len(quiet))
        self.assertEqual(shape_notes(raw, 0, 4, .5, False, amount=0), [])

    def test_creativity_keeps_scale_passing_notes_instead_of_flattening_to_chord(self):
        raw = [(0, .2, 60), (.25, .2, 62), (.5, .2, 64), (.75, .2, 65)]
        simple = shape_notes(raw, 0, 2, .5, False, key='C major', chord='C', creativity=0, amount=1)
        varied = shape_notes(raw, 0, 2, .5, False, key='C major', chord='C', creativity=1, amount=1)
        self.assertTrue(all(n[-1] % 12 in {0,4,7} for n in simple))
        self.assertTrue(any(n[-1] % 12 in {2,5} for n in varied))

    def test_output_lands_on_tempo_grid_at_multiple_tempos(self):
        for bpm in (80, 133, 180):
            beat = 60 / bpm
            start = 12 * beat
            raw = [(start + x * beat, .07, 60) for x in (.03, .57, 1.13, 2.79, 3.97)]
            notes = shape_notes(raw, start, start + 4 * beat, beat, False, creativity=1, amount=1)
            self.assertTrue(notes)
            for t, d, _ in notes:
                self.assertAlmostEqual((t - start) / beat * 4, round((t-start) / beat * 4))
                self.assertGreaterEqual(d / beat, .25 - 1e-8)
                self.assertLessEqual(t+d, start + 4 * beat + 1e-8)

    def test_voice_chord_yields_two_to_three_chord_tone_notes(self):
        chord_tones = harmony_classes('C major', 'Dm')
        notes = voice_chord(66, chord_tones, want=3)
        self.assertGreaterEqual(len(notes), 2)
        self.assertLessEqual(len(notes), 3)
        self.assertTrue(all(p % 12 in chord_tones for p in notes))
        self.assertEqual(len(set(notes)), len(notes))

    def test_voice_chord_falls_back_to_monophonic_without_a_chord(self):
        self.assertEqual(voice_chord(66, set()), [66])

    def test_early_entry_plan_covers_bar_1_with_key_and_chord_but_no_melody(self):
        # bar 1 spans beats 4..8, matching plan_window(0) in server.py.
        notes = early_entry_plan('A minor', 'Am', 4.0, 8.0)
        self.assertTrue(notes)
        self.assertTrue(all(n['beat'] < 8.0 for n in notes))
        bass = [n for n in notes if n['voice'] == 'bass']
        keys = [n for n in notes if n['voice'] == 'keys']
        self.assertEqual(sorted(n['beat'] for n in bass), [4.0, 6.0])
        self.assertTrue(all(n['pitch'] % 12 == 9 for n in bass))  # A
        self.assertGreaterEqual(len(keys), 2)
        self.assertLessEqual(len(keys), 3)
        self.assertTrue(all(n['beat'] == 4.0 for n in keys))
        chord_tones = harmony_classes('A minor', 'Am')
        self.assertTrue(all(n['pitch'] % 12 in chord_tones for n in keys))

    def test_early_entry_plan_is_empty_without_key_or_chord(self):
        self.assertEqual(early_entry_plan(None, None, 4.0, 8.0), [])

    def test_bass_uses_the_players_harmony_in_a_fixed_bass_register(self):
        self.assertEqual(bass_pitch('Dm', 'C major'), 38)
        self.assertEqual(bass_pitch('F#min7', 'C major'), 42)
        self.assertEqual(bass_pitch(None, 'A minor'), 45)
        self.assertIsNone(bass_pitch(None, None))


if __name__ == '__main__':
    unittest.main()


class FillSilentWindowTests(unittest.TestCase):
    def test_empty_window_gets_the_key_only_plan(self):
        out = fill_silent_window([], 'A minor', 'Am', 8.0, 12.0)
        self.assertTrue(out)
        self.assertEqual(sorted(n['beat'] for n in out if n['voice'] == 'bass'), [8.0, 10.0])
        self.assertTrue(any(n['voice'] == 'keys' for n in out))

    def test_window_with_keys_is_left_alone(self):
        notes = [{'beat': 8.0, 'pitch': 64, 'dur': 1.0, 'vel': 0.5, 'voice': 'keys'}]
        self.assertIs(fill_silent_window(notes, 'A minor', 'Am', 8.0, 12.0), notes)

    def test_no_key_no_chord_stays_empty(self):
        self.assertEqual(fill_silent_window([], None, None, 8.0, 12.0), [])

