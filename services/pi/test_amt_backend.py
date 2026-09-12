"""CPU tests: run in the AMT venv; no checkpoint needed."""
import unittest
try:
    import torch
    from transformers import GPT2Config, GPT2LMHeadModel
    import amt_backend as backend
except ModuleNotFoundError as exc:
    if exc.name in {'torch', 'transformers', 'fastapi', 'uvicorn', 'anticipation', 'musicpy', 'mido'}:
        raise unittest.SkipTest('Optional AMT venv dependencies are not installed') from exc
    raise


class CacheTests(unittest.TestCase):
    def test_padding_depends_on_retained_context_not_session_age(self):
        from anticipation.vocab import TIME_OFFSET, DUR_OFFSET, NOTE_OFFSET
        inputs = [TIME_OFFSET + 100, DUR_OFFSET + 20, NOTE_OFFSET + 60]
        early = backend.prepare_context(inputs, 200)
        shifted = inputs.copy()
        shifted[0] += 100000
        late = backend.prepare_context(shifted, 100200)
        late[::3] = [t - 100000 for t in late[::3]]
        self.assertEqual(early, late)
        self.assertLess(len(late), 12)

    def test_cached_logits_match_full_prefix(self):
        torch.manual_seed(2)
        model = GPT2LMHeadModel(GPT2Config(vocab_size=32, n_positions=32,
            n_embd=24, n_layer=2, n_head=2)).eval()
        ids = torch.tensor([[1, 2, 3]])
        with torch.inference_mode():
            logits, cache = backend.forward_last(model, ids)
            torch.testing.assert_close(logits, model(ids).logits[0, -1])
            next_ids = torch.tensor([[4]])
            logits, _ = backend.forward_last(model, next_ids, cache)
            torch.testing.assert_close(logits, model(torch.tensor([[1, 2, 3, 4]])).logits[0, -1])

    def test_restricted_head_preserves_allowed_logits(self):
        from anticipation.vocab import DUR_OFFSET, NOTE_OFFSET, REST
        model = GPT2LMHeadModel(GPT2Config(vocab_size=55028, n_positions=32,
            n_embd=12, n_layer=1, n_head=2)).eval()
        ids = torch.tensor([[1, 2, 3]])
        with torch.inference_mode():
            full, _ = backend.forward_last(model, ids)
            for slot, (start, end) in enumerate([(0, DUR_OFFSET),
                    (DUR_OFFSET, NOTE_OFFSET), (NOTE_OFFSET, REST)]):
                restricted, _ = backend.forward_last(model, ids, slot=slot)
                torch.testing.assert_close(full[start:end], restricted[start:end])
                torch.testing.assert_close(full[REST], restricted[REST])

    def test_convert_preserves_gpt2_output(self):
        model = GPT2LMHeadModel(GPT2Config(vocab_size=32, n_positions=32,
            n_embd=24, n_layer=2, n_head=2)).eval()
        ids = torch.tensor([[1, 2, 3]])
        with torch.inference_mode():
            before = model(ids).logits
            backend.convert_conv1d(model)
            torch.testing.assert_close(before, model(ids).logits)


class ProtocolTests(unittest.TestCase):
    def test_fast_tempo_plans_are_contiguous_with_two_bars_of_lead(self):
        self.assertEqual(backend.shared.plan_window(3), (16.0, 20.0))
        self.assertEqual(backend.shared.plan_window(2, 2), (16.0, 24.0))
        self.assertEqual(backend.shared.plan_window(4, 2), (24.0, 32.0))

    def test_start_notes_set_bar_contract(self):
        from unittest.mock import patch
        from fastapi.testclient import TestClient

        class Session:
            def __init__(self, model):
                self.human_notes = []
                self.model = model
                self.key = None
                self.chord = None
            def reset(self, *args):
                self.reset_args = args
            def add_human_notes(self, notes):
                self.human_notes.extend(notes)
            def generate_next_bar_plan(self, bar):
                return {'plan': {'type': 'plan', 'fromBeat': (bar + 1) * 4,
                    'toBeat': (bar + 2) * 4, 'notes': [{'beat': (bar + 1) * 4,
                    'dur': 1, 'pitch': self.human_notes[-1]['pitch'], 'vel': .5, 'voice': 'keys'}]},
                    'status': {'type': 'status', 'latencyMs': 1, 'tokensPerSec': 3}}

        with patch.object(backend, 'load_model', return_value=object()), \
             patch.object(backend.shared, 'Session', Session), TestClient(backend.app) as client:
            health = client.get('/health', headers={'Origin': 'http://127.0.0.1:8088'})
            self.assertEqual(health.headers['access-control-allow-origin'], 'http://127.0.0.1:8088')
            with client.websocket_connect('/amt') as ws:
                ws.send_json({'type': 'start', 'bpm': 0})
                self.assertEqual(ws.receive_json()['type'], 'error')
                ws.send_json({'type': 'start', 'bpm': 100})
                ws.send_json({'type': 'notes', 'notes': [{'beat': 0, 'pitch': 64, 'dur': .5}]})
                ws.send_json({'type': 'set', 'key': 'C major', 'chord': 'C', 'creativity': .3})
                ws.send_json({'type': 'bar', 'bar': 1})
                plan = ws.receive_json()
                self.assertEqual(plan['fromBeat'], 8)
                self.assertEqual(plan['notes'][0]['pitch'], 64)
                self.assertEqual(ws.receive_json()['type'], 'status')


if __name__ == '__main__':
    unittest.main()
