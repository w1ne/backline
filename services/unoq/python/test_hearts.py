import unittest
import hearts as h


def playing(**over):
    s = {'online': True, 'power': 'on', 'audioSuspended': False, 'locked': True, 'bpm': 120,
         'intensity': 0.5, 'inputLevel': 0.075, 'activeParts': {'bass': True, 'drums': True},
         'enabled': {'lead': True}, 'barStartedAt': 1000, 'bar': 7}
    s.update(over)
    return s


class HeartsTests(unittest.TestCase):
    def test_modes(self):
        self.assertEqual(h.mode({}), h.MODE_OFFLINE)
        self.assertEqual(h.mode({'online': True, 'power': 'on'}), h.MODE_LISTEN)
        self.assertEqual(h.mode(playing()), h.MODE_PLAY)
        self.assertEqual(h.mode(playing(audioSuspended=True)), h.MODE_OFFLINE)

    def test_energy_mixes_intensity_level_and_parts(self):
        self.assertAlmostEqual(h.energy(playing()), 0.4 * 0.5 + 0.4 * 0.5 + 0.2 * 0.5)
        self.assertEqual(h.energy(playing(intensity=1, inputLevel=9, activeParts={'a': 1, 'b': 1, 'c': 1, 'd': 1})), 1.0)
        self.assertEqual(h.energy({'intensity': 'nan', 'inputLevel': None}), 0.0)

    def test_flags(self):
        self.assertEqual(h.flags(playing()), 0)
        self.assertEqual(h.flags(playing(fill=True)), h.FLAG_FILL)
        self.assertEqual(h.flags(playing(space=True)), h.FLAG_ANSWER)
        self.assertEqual(h.flags(playing(space=True, enabled={'lead': False})), 0)

    def test_beat_args_carry_bar_phase_only_while_playing(self):
        self.assertEqual(h.beat_args(playing(), 1450)[4], 450)
        self.assertEqual(h.beat_args(playing(), 900)[4], 0)
        self.assertEqual(h.beat_args({'online': True, 'power': 'on'}, 5000), (0.0, 0.2, h.MODE_LISTEN, 0, -1))

    def test_sender_sends_on_change_and_once_per_bar(self):
        calls = []
        s = h.Sender(lambda *a: calls.append(a))
        self.assertTrue(s.push(playing(), 1100))
        self.assertFalse(s.push(playing(), 1300))
        self.assertTrue(s.push(playing(bar=8, barStartedAt=3000), 3100))
        self.assertTrue(s.push(playing(bar=8, barStartedAt=3000, fill=True), 3200))
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[0][0], 'beat')
        self.assertEqual(calls[2][4], h.FLAG_FILL)


if __name__ == '__main__':
    unittest.main()
