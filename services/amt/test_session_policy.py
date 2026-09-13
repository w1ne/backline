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
from musical_identity import MusicalIdentity
from performance_history import PerformanceHistory


PRESETS = {'strings': (40, 41, 42), 'guitar': (24,), 'sax': (65,)}


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
    apply_node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'apply_session_message')
    namespace = dict(MusicalIdentity=MusicalIdentity, Arranger=Arranger, HarmonyBrain=HarmonyBrain, PerformanceHistory=PerformanceHistory,
                     sampling_for=sampling_for, plan_window=plan_window, ACCOMP_BIAS=2,
                     PLAN_LOOKAHEAD_BEATS=4., BEATS_PER_BAR=4., CONTEXT_BEATS=16., FILL_UNTIL_HEARD_BEATS=8., RESUME_LISTEN_BEATS=2.,
                     DEFAULT_PRESETS=('strings',), MELODY_INSTR=0, TIME_OFFSET=0, DUR_OFFSET=0, MAX_DUR=1000,
                     TIME_RESOLUTION=100, DEFAULT_RTT_S=.25, DEADLINE_MARGIN_S=.15, DEADLINE_FLOOR_S=.1, SAMPLER='cached',
                     make_event=encode, AccompanimentCommitter=Committer,
                     resolve_instruments=lambda names: tuple(p for name in names for p in PRESETS.get(name, ())),
                     resolve_groups=lambda names: [PRESETS[name] for name in names if name in PRESETS],
                     generate_duet=generate, parse_events=lambda result: result,
                     build_prompt=lambda history, *a: (history, 0.0),
                     ops=SimpleNamespace(clip=lambda *a, **kw: [], pad=lambda *a, **kw: []),
                     time=__import__('time'), log=logging.getLogger('test'))
    exec(compile(ast.Module(body=[node, apply_node], type_ignores=[]), 'server.py', 'exec'), namespace)
    namespace['Session'].apply_message = staticmethod(namespace['apply_session_message'])
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
        self.session.brain.on_bar(2)  # These tests isolate role/lifecycle policy after intro.
        self.session.add_human_notes([{'id': 'n1', 'beat': 0, 'pitch': 60, 'held': True}])

    def test_single_empty_window_is_rest_two_in_a_row_are_filled(self):
        # Ten beats of the singer heard (note at 0, cue at 10): one empty window is a rest ...
        out = self.session.generate_tick_plan(10)
        self.assertEqual(out['plan']['notes'], [])
        self.assertEqual([c[4] for c in self.calls], [(24,), (40, 41, 42)])  # one pass per preset
        # ... a second empty window in a row is filled with the key-only plan, routed by role.
        out = self.session.generate_tick_plan(12)
        notes = out['plan']['notes']
        self.assertTrue(notes)
        self.assertEqual({n['voice'] for n in notes}, {'keys', 'bass'})
        self.assertTrue(all(14 <= n['beat'] < 16 for n in notes))
        # A window the model does fill resets the streak, so the next empty one is a rest again.
        self.model_notes = [(8.0, .5, 40, 60)]  # 8.0 s = beat 16, inside the [16, 18) window
        self.assertEqual(len(self.session.generate_tick_plan(14)['plan']['notes']), 1)
        self.model_notes = []
        self.assertEqual(self.session.generate_tick_plan(16)['plan']['notes'], [])

    def test_empty_window_is_filled_while_fewer_than_eight_beats_heard(self):
        out = self.session.generate_tick_plan(2)  # two beats since the first note
        self.assertTrue(out['plan']['notes'])
        self.assertEqual(len(self.calls), 2)

    def test_fill_obeys_muted_roles(self):
        self.session.set_controls({'enabledRoles': {'keys': False, 'bass': True, 'lead': True}})
        notes = self.session.generate_tick_plan(2)['plan']['notes']
        self.assertTrue(notes)
        self.assertEqual({n['voice'] for n in notes}, {'bass'})

    def test_deadline_is_window_minus_rtt_minus_margin(self):
        # 120 bpm, lookahead 2: the plan's first note is due 1.0 s after the cue. Two presets are
        # selected, so each sampling pass gets half of what is left.
        self.session.generate_tick_plan(2)
        self.assertAlmostEqual(self.kwargs[0]['deadline_s'], (1.0 - .25 - .15) / 2)  # default 250 ms rtt
        self.session.generate_tick_plan(4, rtt_ms=100)
        self.assertAlmostEqual(self.kwargs[2]['deadline_s'], (1.0 - .1 - .15) / 2)
        self.session.generate_tick_plan(6, rtt_ms=5000)
        self.assertAlmostEqual(self.kwargs[4]['deadline_s'], .1 / 2)  # never below the floor

    def test_each_selected_preset_gets_its_own_masked_pass(self):
        self.session.set_controls({'accompInstruments': ['strings', 'sax', 'guitar']})
        per_group = {(40, 41, 42): [(2, .5, 42, 48)], (65,): [(2, .5, 65, 67)], (24,): [(2, .5, 24, 64)]}
        self.model_notes = None

        def generate(*args, **kwargs):
            self.calls.append(args)
            return per_group[args[4]]
        self.session = session_class(generate)(SimpleNamespace())
        self.session.reset(120, 2, 2, 0, .95, instrument_names=['strings', 'sax', 'guitar'], key='C major')
        self.session.brain.on_bar(2)  # These tests isolate role/lifecycle policy after intro.
        self.session.add_human_notes([{'id': 'n1', 'beat': 0, 'pitch': 60, 'held': True}])
        notes = self.session.generate_tick_plan(2)['plan']['notes']
        self.assertEqual([c[4] for c in self.calls], [(40, 41, 42), (65,), (24,)])
        self.assertEqual(sorted((n['voice'], n['gmInstr']) for n in notes), [('bass', 42), ('keys', 65), ('lead', 24)])

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
        self.assertEqual(self.calls[-1][3][:3], [0, 150, 60])
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

    def test_set_bpm_rescales_seconds_and_keeps_beats(self):
        # This pins token bookkeeping, not harmony: the hand table keeps the chord (and so the
        # chord-pad tokens) fixed while the tempo changes.
        self.session.brain.predictor = 'table'
        # Two beats heard at 120 bpm (0.5 s/beat), one accompaniment window committed ...
        self.session.update_human_notes([{'id': 'n1', 'dur': 1}])
        self.session.add_human_notes([{'id': 'n2', 'beat': 2, 'pitch': 64, 'dur': 1}])
        self.model_notes = [(2.0, .5, 24, 48)]
        self.session.generate_tick_plan(2)
        self.model_notes = []
        self.assertEqual(self.session.history, [0, 50, 60, 100, 50, 64, 200, 50, 24 * 128 + 48])
        horizon, heard, listen = self.session.committed_horizon_beats, self.session.brain.notes_heard, self.session.listen_beats
        # ... then the tempo halves: every second doubles, nothing measured in beats moves.
        self.session.apply_message(self.session, {'type': 'set', 'bpm': 60})
        self.assertEqual(self.session.bpm, 60)
        self.assertAlmostEqual(self.session.beat_s, 1.0)
        self.assertAlmostEqual(self.session.performance.beat_seconds, 1.0)
        self.assertEqual(self.session.history, [0, 100, 60, 200, 100, 64, 400, 100, 24 * 128 + 48])
        self.assertEqual(self.session.human_notes, [(0., 1., 60), (2., 1., 64)])
        self.assertEqual((self.session.committed_horizon_beats, self.session.brain.notes_heard, self.session.listen_beats),
                         (horizon, heard, listen))
        self.assertEqual(self.session.first_human_beat, 0)
        # A release after the change is encoded at the new tempo, in the right token slot.
        self.session.update_human_notes([{'id': 'n2', 'dur': 2}])
        self.assertEqual(self.session.history[3:6], [200, 200, 64])
        # The next window generates in the new seconds domain.
        self.session.generate_tick_plan(4)
        self.assertEqual(self.calls[-1][1:3], (6.0, 8.0))

    def test_set_without_bpm_or_same_bpm_leaves_history_alone(self):
        self.session.update_human_notes([{'id': 'n1', 'dur': 1}])
        before = list(self.session.history)
        self.session.apply_message(self.session, {'type': 'set', 'creativity': .5})
        self.session.apply_message(self.session, {'type': 'set', 'bpm': 120})
        self.session.apply_message(self.session, {'type': 'set', 'bpm': 'fast'})
        self.session.apply_message(self.session, {'type': 'set', 'bpm': 0})
        self.assertEqual(self.session.history, before)
        self.assertEqual(self.session.bpm, 120)

    def test_resume_start_listens_two_beats_not_eight(self):
        self.session.apply_message(self.session, {'type': 'start', 'bpm': 100, 'listenBeats': 8, 'resume': True})
        self.assertEqual(self.session.listen_beats, 2)
        self.session.apply_message(self.session, {'type': 'start', 'bpm': 100, 'listenBeats': 8})
        self.assertEqual(self.session.listen_beats, 8)


if __name__ == '__main__':
    unittest.main()


def test_session_uses_current_brain_section_to_constrain_and_commit():
    def generate(model, start, end, history, instruments, *args, **kwargs):
        return [(start + i * .25, .2, instruments[0], 64) for i in range(4)]
    session = session_class(generate)(SimpleNamespace())
    session.reset(120, 2, 2, 0, .95, instrument_names=['guitar'])
    session.add_human_notes([{'beat': 0, 'pitch': 60, 'dur': 1}])
    intro = session.generate_tick_plan(2)['plan']
    assert intro['section'] == 'intro'
    assert len(intro['notes']) == 1
    # Reach a sustained-energy lift, not a hand-edited section string.
    session.set_controls({'intensity': .9, 'amount': 1})
    for cue in (4, 8, 12, 16):
        session.add_human_notes([{'beat': cue, 'pitch': 60, 'dur': 1}])
        lift = session.generate_tick_plan(cue)['plan']
    assert lift['section'] == 'lift'
    assert len(lift['notes']) > len(intro['notes'])
    last = lift['notes'][-1]
    assert session.history[-3:] == encode(last['beat'] * .5, last['dur'] * .5,
                                        last['gmInstr'], last['pitch'])


def identity_session(pitches, bpm=120):
    def generate(model, start, end, history, instruments, *args, **kwargs):
        return [(start + i * 60 / bpm, .4 * 60 / bpm, instruments[0], 64) for i in range(2)]
    session = session_class(generate)(SimpleNamespace())
    session.reset(bpm, 2, 2, 0, .95, instrument_names=['guitar'], key='C major')
    session.set_controls({'amount': 1, 'creativity': .3, 'phraseResponses': True})
    session.add_human_notes([{'id': str(i), 'beat': i, 'pitch': p, 'dur': .5}
                             for i, p in enumerate(pitches)])
    return session


def test_human_hook_changes_committed_answer_with_same_model_output():
    a = identity_session([60, 64, 67, 64, 60, 64, 67, 64])
    b = identity_session([60, 55, 60, 64, 60, 55, 60, 64])
    pa, pb = (s.generate_tick_plan(10)['plan'] for s in (a, b))
    assert pa.get('phraseResponse') and pb.get('phraseResponse')
    assert pa['phraseFromBeat'] == pa['fromBeat']
    assert pa['phraseToBeat'] == min(pa['toBeat'], pa['fromBeat'] + 2)
    assert [n['pitch'] for n in pa['notes']] != [n['pitch'] for n in pb['notes']]
    for session, plan in ((a, pa), (b, pb)):
        assert plan['notes']
        for n in plan['notes']:
            assert plan['fromBeat'] <= n['beat'] < n['beat'] + n['dur'] <= plan['toBeat']
        encoded = sum((encode(n['beat'] * .5, n['dur'] * .5, n['gmInstr'], n['pitch'])
                       for n in plan['notes']), [])
        assert session.history[-len(encoded):] == encoded


def test_phrase_memory_isolated_in_candidate_and_reset_for_new_song():
    from live_session import clone_session
    session = identity_session([60, 64, 67, 64, 60, 64, 67, 64])
    snapshot = clone_session(session)
    assert snapshot.generate_tick_plan(10)['plan'].get('phraseResponse')
    assert not session.identity.phrase
    assert session.generate_tick_plan(10)['plan'].get('phraseResponse')
    session.reset(120, 2, 2, 0, .95)
    assert not session.identity.phrase


def test_no_phrase_answer_after_held_note_or_zero_amount():
    for control in ('held', 'mute'):
        session = identity_session([60, 64, 67, 64, 60, 64, 67, 64])
        session.generate_tick_plan(10)
        if control == 'held':
            session.add_human_notes([{'id': 'held', 'beat': 18, 'pitch': 69, 'held': True}])
        else:
            session.set_controls({'amount': 0})
        plan = session.generate_tick_plan(18)['plan']
        assert not plan.get('phraseResponse')
        if control == 'mute':
            assert plan['notes'] == []


def test_older_client_never_receives_an_uncancellable_phrase_response():
    session = identity_session([60,64,67,64,60,64,67,64])
    session.set_controls({'phraseResponses': False})
    plan = session.generate_tick_plan(10)['plan']
    assert not plan.get('phraseResponse')
    assert not plan.get('phraseInstrument')
    assert plan['notes']  # Ordinary AMT backing and section policy still work.
