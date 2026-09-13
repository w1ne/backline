"""/health is readiness: 503 until the model is loaded, 503 with the error if loading failed."""
import unittest

from readiness import health_response


class HealthResponseTests(unittest.TestCase):
    def test_loading_is_503_with_status_loading(self):
        code, body = health_response(model_loaded=False, load_error=None, model='m', device=None, sampler='cached')
        self.assertEqual(code, 503)
        self.assertEqual(body['status'], 'loading')
        self.assertEqual(body['model'], 'm')

    def test_loaded_is_200_ok(self):
        code, body = health_response(model_loaded=True, load_error=None, model='m', device='cuda', sampler='cached')
        self.assertEqual((code, body['status'], body['device']), (200, 'ok', 'cuda'))

    def test_failed_load_is_503_with_the_error(self):
        code, body = health_response(model_loaded=False, load_error=RuntimeError('no HF'), model='m', device='cpu', sampler='cached')
        self.assertEqual(code, 503)
        self.assertEqual(body['status'], 'error')
        self.assertIn('no HF', body['error'])


if __name__ == '__main__':
    unittest.main()
