import unittest
from performance_history import PerformanceHistory


def encode(onset, duration, instrument, pitch):
    return [round(onset * 100), round(duration * 100), instrument * 128 + pitch]


class PerformanceHistoryTests(unittest.TestCase):
    def setUp(self):
        self.tokens = []
        self.heard = []
        self.history = PerformanceHistory(self.tokens, encode, 0, .5,
                                          lambda pitch, beat: self.heard.append((pitch, beat)))

    def onset(self, note_id='mic:1', beat=2):
        self.history.add([{'id': note_id, 'beat': beat, 'dur': .5, 'pitch': 60,
                           'held': True, 'vel': .73, 'source': 'mic', 'confidence': .91, 'captureTimeSec': 123.4}])

    def test_onset_immediate_release_rewrites_only_duration(self):
        self.onset()
        self.assertEqual(self.tokens, [100, 25, 60])
        self.history.update([{'id': 'mic:1', 'dur': 3, 'captureTimeSec': 124.9}])
        self.assertEqual(self.tokens, [100, 150, 60])
        self.assertEqual(self.history.notes, [(2., 3., 60)])
        self.assertEqual(self.heard, [(60, 2.)])
        self.assertEqual(self.history.records['mic:1']['source'], 'mic')

    def test_held_duration_advances_to_cue_and_freezes_after_release(self):
        self.onset()
        self.history.observe_through(6)
        self.assertEqual(self.tokens[1], 200)
        self.history.update([{'id': 'mic:1', 'dur': 4.2}])
        self.history.observe_through(10)
        self.assertEqual(self.tokens[1], 210)

    def test_duplicate_onset_and_unknown_release_do_not_add_notes(self):
        self.onset()
        self.onset()
        self.history.update([{'id': 'unknown', 'dur': 3}])
        self.assertEqual(len(self.tokens), 3)
        self.assertEqual(len(self.heard), 1)

    def test_prune_shifts_indices_without_rewriting_accompaniment(self):
        self.onset('old', 0)
        self.history.update([{'id': 'old', 'dur': 1}])
        self.tokens.extend(encode(2, 1, 24, 64))
        self.onset('new', 4)
        del self.tokens[:3]
        self.history.drop_prefix(3, 2)
        self.history.update([{'id': 'old', 'dur': 10}, {'id': 'new', 'dur': 2}])
        self.assertEqual(self.tokens, [200, 100, 24 * 128 + 64, 200, 100, 60])
        self.assertNotIn('old', self.history.records)

    def test_long_held_note_survives_pruning_with_clipped_model_context(self):
        self.onset('long', 0)
        self.history.observe_through(20)
        del self.tokens[:3]
        self.history.drop_prefix(3, 4)
        self.assertEqual(self.tokens, [200, 800, 60])
        self.assertEqual(self.history.notes, [(0., 20., 60)])
        self.history.update([{'id': 'long', 'dur': 21}])
        self.assertEqual(self.tokens, [200, 850, 60])
        self.assertEqual(self.history.notes, [(0., 21., 60)])
        self.assertEqual(len(self.heard), 1)

    def test_invalid_durations_do_not_corrupt_existing_history(self):
        self.onset()
        for duration in (-1, float('nan'), float('inf')):
            self.history.update([{'id': 'mic:1', 'dur': duration}])
        self.assertEqual(self.tokens, [100, 25, 60])

    def test_legacy_notes_remain_compatible_and_are_not_assumed_held(self):
        self.history.add([{'beat': 0, 'pitch': 64, 'dur': 1}])
        self.history.observe_through(8)
        self.assertEqual(self.tokens, [0, 50, 64])


if __name__ == '__main__':
    unittest.main()
