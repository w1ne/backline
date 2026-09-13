"""Execute the real Session class with tiny model/token stand-ins, without torch.

The AST loader only skips module startup/imports. All policy branches under test
are the production methods; the expensive sampler and token codec are injected.
"""
import ast
import copy
import logging
from pathlib import Path
from types import SimpleNamespace
import unittest

from arrangement import Arranger, plan_window
from brain import HarmonyBrain, sampling_for
from performance_history import PerformanceHistory


def encode(t, d, instrument, pitch):
    return [round(t * 100), round(d * 100), instrument * 128 + pitch]


class Committer:
    def __init__(self, history):
        self.history = history

    def commit(self, notes):
        for note in notes:
            self.history.extend(encode(*note))
        return notes

    def drop_prefix(self, count):
        pass


def session_class(generate):
    tree = ast.parse(Path(__file__).with_name('server.py').read_text())
    node = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == 'Session')
    namespace = dict(Arranger=Arranger, HarmonyBrain=HarmonyBrain, PerformanceHistory=PerformanceHistory,
                     sampling_for=sampling_for, plan_window=plan_window, ACCOMP_BIAS=2,
                     PLAN_LOOKAHEAD_BEATS=4., BEATS_PER_BAR=4., CONTEXT_BEATS=16.,
                     DEFAULT_PRESETS=('strings',), MELODY_INSTR=0, TIME_OFFSET=0,
                     TIME_RESOLUTION=100, DEFAULT_RTT_S=.25, DEADLINE_MARGIN_S=.15, DEADLINE_FLOOR_S=.1, SAMPLER='cached',
                     make_event=encode, AccompanimentCommitter=Committer,
                     resolve_instruments=lambda names: tuple(p for name in names for p in {'strings': (40, 41, 42), 'guitar': (24,)}.get(name, ())),
                     generate_duet=generate, parse_events=lambda result: result,
                     ops=SimpleNamespace(clip=lambda *a, **kw: [], pad=lambda *a, **kw: []),
                     time=__import__('time'), log=logging.getLogger('test'))
    exec(compile(ast.Module(body=[node], type_ignores=[]), 'server.py', 'exec'), namespace)
    return namespace['Session']


class SessionPolicyTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.kwargs = []
        self.model_notes = []

        def generate(*args, **kwargs):
            self.calls.append(args)
            self.kwargs.append(kwargs)
            return self.model_notes

        self.session = session_class(generate)(SimpleNamespace())
        self.session.reset(120, 2, 2, 0, .95, instrument_names=['guitar', 'strings'], key='C major')
        self.session.add_human_notes([{'id': 'n1', 'beat': 0, 'pitch': 60, 'held': True}])

    def test_successful_empty_model_output_is_rest(self):
        out = self.session.generate_tick_plan(2)
        self.assertEqual(out['plan']['notes'], [])
        self.assertEqual(len(self.calls), 1)

    def test_deadline_is_window_minus_rtt_minus_margin(self):
        # 120 bpm, lookahead 2: the plan's first note is due 1.0 s after the cue.
        self.session.generate_tick_plan(2)
        self.assertAlmostEqual(self.kwargs[0]['deadline_s'], 1.0 - .25 - .15)  # default 250 ms rtt
        self.session.generate_tick_plan(4, rtt_ms=100)
        self.assertAlmostEqual(self.kwargs[1]['deadline_s'], 1.0 - .1 - .15)
        self.session.generate_tick_plan(6, rtt_ms=5000)
        self.assertAlmostEqual(self.kwargs[2]['deadline_s'], .1)  # never below the floor

    def test_listening_and_zero_amount_do_not_generate_or_fill(self):
        self.session.listen_beats = 20
        self.assertEqual(self.session.generate_tick_plan(2)['plan']['notes'], [])
        self.session.listen_beats = 0
        self.session.set_controls({'amount': 0})
        self.assertEqual(self.session.generate_tick_plan(2)['plan']['notes'], [])
        self.assertEqual(self.calls, [])

    def test_muted_roles_are_absent_from_model_mask_and_plan(self):
        self.session.set_controls({'enabledRoles': {'keys': False, 'bass': False, 'lead': True}})
        self.model_notes = [(2, .5, 24, 64), (2, .5, 40, 60), (2, .5, 42, 48)]
        notes = self.session.generate_tick_plan(2)['plan']['notes']
        self.assertEqual(self.calls[0][4], (24,))
        self.assertEqual([(n['voice'], n['gmInstr']) for n in notes], [('lead', 24)])
        self.assertEqual(len(notes), 1)

    def test_all_roles_muted_and_empty_instrument_selection_skip_generation(self):
        self.session.set_controls({'enabledRoles': {'keys': False, 'bass': False, 'lead': False}})
        self.assertEqual(self.session.generate_tick_plan(2)['plan']['notes'], [])
        self.session.set_controls({'enabledRoles': {'keys': True}, 'accompInstruments': []})
        self.assertEqual(self.session.generate_tick_plan(2)['plan']['notes'], [])
        self.assertEqual(self.calls, [])

    def test_real_duration_reaches_model_without_duplicate_note(self):
        self.session.generate_tick_plan(2)
        self.assertEqual(self.calls[0][3][:3], [0, 100, 60])
        self.session.update_human_notes([{'id': 'n1', 'dur': 3}])
        self.session.generate_tick_plan(4)
        self.assertEqual(self.calls[1][3][:3], [0, 150, 60])
        self.assertEqual(len(self.session.human_notes), 1)
        self.assertEqual(self.session.brain.notes_heard, 1)

    def test_long_sustain_remains_bounded_and_accepts_final_release(self):
        for beat in range(2, 102, 2):
            self.session.generate_tick_plan(beat)
            self.assertEqual(len(self.session.history), 3)
        self.session.update_human_notes([{'id': 'n1', 'dur': 101}])
        self.assertEqual(self.session.human_notes, [(0., 101., 60)])
        self.assertEqual(self.session.brain.notes_heard, 1)

    def test_muted_session_still_prunes_context(self):
        self.session.set_controls({'amount': 0})
        self.session.update_human_notes([{'id': 'n1', 'dur': 1}])
        for beat in range(2, 102, 2):
            self.session.add_human_notes([{'beat': beat, 'pitch': 64, 'dur': 1}])
            self.session.generate_tick_plan(beat)
        self.assertLessEqual(len(self.session.history), 27)
        self.assertEqual(self.calls, [])

    def test_snapshot_preserves_aliases_without_mutating_live_history(self):
        snapshot = copy.copy(self.session)
        snapshot.__dict__ = copy.deepcopy({k: v for k, v in self.session.__dict__.items() if k != 'model'})
        snapshot.model = self.session.model
        snapshot.update_human_notes([{'id': 'n1', 'dur': 3}])
        self.assertIs(snapshot.history, snapshot.performance.tokens)
        self.assertIs(snapshot.history, snapshot.committer.history)
        self.assertIs(snapshot.human_notes, snapshot.performance.notes)
        self.assertIs(snapshot.brain, snapshot.performance.on_note.__self__)
        self.assertEqual(self.session.history, [0, 25, 60])
        self.assertEqual(snapshot.history, [0, 150, 60])


if __name__ == '__main__':
    unittest.main()
