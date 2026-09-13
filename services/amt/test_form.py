import unittest
from form import SongForm


def tick(form, bar, intensity, silence_beats=0, player_stopped=False):
    return form.tick(bar, intensity, silence_beats, player_stopped)


class SongFormTest(unittest.TestCase):
    def test_starts_in_intro_for_the_first_two_bars(self):
        form = SongForm()
        self.assertEqual(tick(form, 0, 0.5)["section"], "intro")
        self.assertEqual(tick(form, 1, 0.5)["section"], "intro")

    def test_intro_bars_mark_arrangement_intro_and_nothing_else(self):
        form = SongForm()
        r = tick(form, 0, 0.5)
        self.assertEqual(r["arrangement"], {"intro": True, "lift": False, "breakdown": False, "ending": False})

    def test_moves_to_groove_on_bar_2(self):
        form = SongForm()
        tick(form, 0, 0.5)
        tick(form, 1, 0.5)
        r = tick(form, 2, 0.5)
        self.assertEqual(r["section"], "groove")
        self.assertEqual(r["arrangement"], {"intro": False, "lift": False, "breakdown": False, "ending": False})

    def test_lifts_after_4_bars_of_intensity_above_0_7(self):
        form = SongForm()
        tick(form, 0, 0.9)
        tick(form, 1, 0.9)  # still intro, but streak keeps counting
        last = None
        for bar in range(2, 6):
            last = tick(form, bar, 0.9)
        self.assertEqual(last["section"], "lift")
        self.assertTrue(last["arrangement"]["lift"])

    def test_does_not_lift_on_only_3_bars_above_threshold(self):
        form = SongForm()
        tick(form, 0, 0.5)
        tick(form, 1, 0.5)
        last = None
        for bar in range(2, 5):
            last = tick(form, bar, 0.9)
        self.assertEqual(last["section"], "groove")

    def test_breaks_down_after_4_bars_of_intensity_below_0_3(self):
        form = SongForm()
        tick(form, 0, 0.1)
        tick(form, 1, 0.1)
        last = None
        for bar in range(2, 6):
            last = tick(form, bar, 0.1)
        self.assertEqual(last["section"], "breakdown")
        self.assertTrue(last["arrangement"]["breakdown"])

    def test_returns_to_groove_once_intensity_is_neither_high_nor_low(self):
        form = SongForm()
        tick(form, 0, 0.9)
        tick(form, 1, 0.9)
        for bar in range(2, 6):
            tick(form, bar, 0.9)
        r = tick(form, 6, 0.5)
        self.assertEqual(r["section"], "groove")

    def test_can_go_from_lift_straight_into_breakdown_territory(self):
        form = SongForm()
        tick(form, 0, 0.9)
        tick(form, 1, 0.9)
        for bar in range(2, 6):
            tick(form, bar, 0.9)  # -> lift
        last = None
        for bar in range(6, 10):
            last = tick(form, bar, 0.1)  # -> breakdown
        self.assertEqual(last["section"], "breakdown")

    def test_ends_after_four_full_bars_16_beats_of_silence_past_intro(self):
        form = SongForm()
        tick(form, 0, 0.5)
        tick(form, 1, 0.5)
        r = tick(form, 2, 0, 16)
        self.assertEqual(r["section"], "ending")
        self.assertEqual(r["arrangement"], {"intro": False, "lift": False, "breakdown": False, "ending": True})
        self.assertTrue(r["shouldStop"])

    def test_does_not_end_on_less_than_8_silent_beats(self):
        form = SongForm()
        tick(form, 0, 0.5)
        tick(form, 1, 0.5)
        r = tick(form, 2, 0, 7.9)
        self.assertNotEqual(r["section"], "ending")
        self.assertFalse(r["shouldStop"])

    def test_never_ends_during_intro_even_if_silent(self):
        form = SongForm()
        r = tick(form, 0, 0, 20)
        self.assertEqual(r["section"], "intro")
        self.assertFalse(r["shouldStop"])

    def test_ends_immediately_when_player_stopped_regardless_of_silence_beats(self):
        form = SongForm()
        tick(form, 0, 0.5)
        tick(form, 1, 0.5)
        r = form.tick(2, 0.5, 0, True)
        self.assertEqual(r["section"], "ending")
        self.assertTrue(r["shouldStop"])

    def test_goes_idle_ended_the_tick_after_the_ending_bar_and_stays_idle(self):
        form = SongForm()
        tick(form, 0, 0.5)
        tick(form, 1, 0.5)
        tick(form, 2, 0, 16)
        r1 = tick(form, 3, 0.5, 0)
        self.assertEqual(r1["section"], "ended")
        self.assertFalse(r1["shouldStop"])
        r2 = tick(form, 4, 0.9, 0)
        self.assertEqual(r2["section"], "ended")

    def test_reset_returns_the_form_to_intro(self):
        form = SongForm()
        tick(form, 0, 0.5)
        tick(form, 1, 0.5)
        tick(form, 2, 0, 16)
        tick(form, 3, 0.5)
        form.reset()
        r = tick(form, 0, 0.5)
        self.assertEqual(r["section"], "intro")


if __name__ == "__main__":
    unittest.main()


def test_steady_playing_has_recurring_contrast_without_new_form_clock():
    form = SongForm()
    sections = [form.tick(bar, .5, 0)['section'] for bar in range(34)]
    assert sections[2:10] == ['groove'] * 8
    assert sections[10:18] == ['lift'] * 8
    assert sections[18:26] == ['breakdown'] * 8
    assert sections[26:34] == ['groove'] * 8


def test_repeated_bar_does_not_advance_hysteresis_or_end_twice():
    form = SongForm()
    for _ in range(10):
        assert form.tick(2, .9, 0)['section'] == 'groove'
    ending = form.tick(3, .5, 16)
    assert ending['section'] == 'ending'
    assert form.tick(3, .5, 16) == ending
    assert form.tick(4, .5, 16)['section'] == 'ended'


def test_restart_uses_new_song_origin_without_resetting_transport():
    form = SongForm()
    form.reset(start_bar=20)
    assert form.tick(20, .5, 0)['section'] == 'intro'
    assert form.tick(21, .5, 0)['section'] == 'intro'
    assert form.tick(22, .5, 0)['section'] == 'groove'
    assert form.tick(30, .5, 0)['section'] == 'lift'
