import unittest
from lcd import ControlMapper, FakeDisplay, render, status_lines, Client


class LCDTests(unittest.TestCase):
    def test_screen_fits_and_shows_unknown_values_honestly(self):
        lines = status_lines({'power': 'off', 'genre': 'lofi', 'bpm': None})
        self.assertEqual(len(lines), 6)
        self.assertIn('READY', lines[0])
        self.assertTrue(all(len(line) <= 21 for line in lines))
        self.assertIn('--', lines[2])
        display = FakeDisplay()
        render(display, {'power': 'on', 'bpm': 120, 'key': 'Am', 'chord': 'Am'})
        self.assertEqual(display.frames, 1)
        self.assertIn('PLAY', display.lines[0])

    def test_selected_keyboard_instrument_is_visible(self):
        lines = status_lines({'power': 'on', 'soundLabel': 'Bell keys'})
        self.assertIn('Bell keys N0.00', lines)

    def test_encoder_clamping_and_release(self):
        mapper = ControlMapper()
        self.assertEqual(mapper.command(22, 64, {'intensity': .99})['value'], 1)
        self.assertEqual(mapper.command(25, 64, {'creativity': .01})['value'], 0)
        self.assertIsNone(mapper.command(22, 0, {}))

    def test_foot_press_is_edge_triggered(self):
        mapper = ControlMapper()
        self.assertEqual(mapper.command(64, 64, {'power': 'off'}), {'type': 'transport', 'playing': True})
        self.assertIsNone(mapper.command(64, 64, {'power': 'on'}))
        self.assertIsNone(mapper.command(64, 0, {}))
        self.assertEqual(mapper.command(64, 64, {'power': 'on'}), {'type': 'transport', 'playing': False})

    def test_stale_browser_overrides_playing_and_audio_wait(self):
        lines = status_lines({'online': False, 'power': 'on', 'audioSuspended': True})
        self.assertIn('OFFLINE', lines[0])
        self.assertIn('Browser disconnected', lines[-1])

    def test_stale_controls_are_dropped_without_replaying_held_press(self):
        mapper = ControlMapper()
        stale = {'online': False, 'power': 'off'}
        fresh = {'online': True, 'power': 'off'}
        self.assertIsNone(mapper.command(22, 64, stale))
        self.assertIsNone(mapper.command(64, 64, stale))
        self.assertIsNone(mapper.command(64, 64, fresh))
        self.assertIsNone(mapper.command(64, 0, stale))
        self.assertEqual(mapper.command(64, 64, fresh), {'type': 'transport', 'playing': True})

    def test_invalid_status_rejected(self):
        self.assertRaises(ValueError, Client.validate_status, [])

    def test_offline_error_visible(self):
        lines = status_lines({}, 'API unavailable')
        self.assertIn('OFFLINE', lines[0])
        self.assertIn('API unavailable', lines[-1])


if __name__ == '__main__':
    unittest.main()
