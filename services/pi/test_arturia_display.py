import unittest
from arturia_display import display_payload, display_lines

class ArturiaDisplayTests(unittest.TestCase):
    def test_selected_sound_and_noise_are_shown(self):
        self.assertEqual(display_lines({'online': True, 'soundLabel':'Bell keys', 'noiseVolume': .25}), ('duet.ai N0.25', 'Bell keys'))
        self.assertEqual(display_lines({'online': False}), ('duet.ai', 'Disconnected'))
    def test_payload_is_bounded_ascii_and_cannot_inject_sysex_commands(self):
        data = display_payload('a'*100, 'x\x00\xf7\n')
        self.assertEqual(data[:8], [0,32,107,127,66,4,2,96])
        self.assertTrue(all(0 <= n < 128 for n in data))
        self.assertEqual(data[8:26], [1]+[97]*16+[0])
        self.assertLess(len(data), 45)
