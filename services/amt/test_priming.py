"""Needs the `anticipation` package (pod venv): python -m unittest test_priming"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "bench" / "amt"))

try:
    import anticipation  # noqa: F401
except ImportError:  # pragma: no cover
    raise unittest.SkipTest("anticipation package not installed")

import priming
from amt import parse_events, make_event


class PrimingTests(unittest.TestCase):
    def test_prime_uses_pass_instruments_and_melody_program(self):
        ev = priming.prime_events('jazz', 'C major', (40, 41, 42), .6)
        instrs = {i for _, _, i, _ in ev}
        self.assertEqual(instrs, {0, 40, 41, 42})
        self.assertTrue(all(0 <= t < priming.PRIME_BEATS * .6 for t, _, _, _ in ev))

    def test_prime_transposes_to_key(self):
        c = sorted(p for _, _, i, p in priming.prime_events('rock', 'C major', (24,), .5) if i == 0)
        d = sorted(p for _, _, i, p in priming.prime_events('rock', 'D major', (24,), .5) if i == 0)
        self.assertEqual([p + 2 for p in c], d)
        a_minor = sorted(p for _, _, i, p in priming.prime_events('rock', 'A minor', (24,), .5) if i == 0)
        self.assertEqual(c, a_minor)

    def test_chord_pad_spans_window_on_unused_program(self):
        pad = priming.chord_pad_events('C major', 'G7', 10., 12., .5)
        self.assertEqual({i for _, _, i, _ in pad}, {priming.PAD_INSTR})
        self.assertTrue(all(t == 9. and abs(t + d - 12.) < 1e-9 for t, d, _, _ in pad))
        self.assertEqual(sorted(p % 12 for _, _, _, p in pad), [2, 5, 7, 11])

    def test_build_prompt_shifts_history_and_round_trips(self):
        history = make_event(2., .5, 0, 60)
        tokens, shift = priming.build_prompt(history, (40,), 'C major', 'lofi', 'Am', 4., 6., .5)
        self.assertGreater(shift, 0)
        events = list(parse_events(tokens))
        melody = [(t, p) for t, _, i, p in events if i == 0 and abs(t - (2. + shift)) < 1e-6]
        self.assertEqual(melody, [(2. + shift, 60)])
        self.assertTrue(any(i == priming.PAD_INSTR for _, _, i, _ in events))
        self.assertTrue(all(t < shift for t, _, i, _ in events if i == 40))


if __name__ == '__main__':
    unittest.main()
