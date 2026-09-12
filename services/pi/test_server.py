import unittest
from server import DeviceState, validate_command


class DeviceServerTest(unittest.TestCase):
    def test_only_supported_bounded_commands_are_accepted(self):
        for command in [dict(type='set', field='intensity', value=2),
                        dict(type='set', field='engine', value='arbitrary'),
                        dict(type='toggle', instrument='system'),
                        dict(type='bpm', bpm=500), dict(type='transport', playing='yes')]:
            with self.assertRaises(ValueError):
                validate_command(command)
        self.assertEqual(validate_command(dict(type='bpm', bpm=None)), dict(type='bpm', bpm=None))
        self.assertEqual(validate_command(dict(type='set', field='creativity', value=0.4))['value'], 0.4)

    def test_cloud_and_performer_controls(self):
        for field, value in [('engine','acestep'),('sound','grand'),('noiseVolume',.2),('droneVolume',0)]:
            self.assertEqual(validate_command(dict(type='set',field=field,value=value))['value'], value)
        for field, value in [('sound','arbitrary'),('noiseVolume',1.1),('droneVolume',float('nan'))]:
            with self.assertRaises(ValueError):
                validate_command(dict(type='set',field=field,value=value))

    def test_commands_survive_poll_retry_until_acknowledged(self):
        state = DeviceState()
        state.enqueue(dict(type='toggle', instrument='keys'))
        first = state.commands(0)
        self.assertEqual(first, state.commands(0))
        self.assertEqual(state.commands(first[-1]['id']), [])

    def test_full_queue_does_not_silently_drop_a_toggle(self):
        state = DeviceState()
        for _ in range(128):
            state.enqueue(dict(type='toggle', instrument='keys'))
        with self.assertRaises(OverflowError):
            state.enqueue(dict(type='toggle', instrument='keys'))

class DeviceHTTPTest(unittest.TestCase):
    def test_status_command_roundtrip_and_static_boundary(self):
        import json
        from pathlib import Path
        import tempfile
        import threading
        from http.server import ThreadingHTTPServer
        from urllib.request import urlopen, Request
        from urllib.error import HTTPError
        from server import handler_for
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'site'
            root.mkdir()
            (Path(temp) / 'private.txt').write_text('outside')
            (root / 'index.html').write_text('app')
            state = DeviceState()
            server = ThreadingHTTPServer(('127.0.0.1', 0), handler_for(root, state))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = 'http://127.0.0.1:' + str(server.server_port)
            try:
                request = Request(base + '/api/command', data=json.dumps(dict(type='bpm', bpm=100)).encode(), headers={'Content-Type': 'application/json'})
                with urlopen(request) as response:
                    self.assertEqual(response.status, 202)
                with urlopen(base + '/api/commands') as response:
                    packet = json.load(response)
                    self.assertEqual(packet['commands'][0]['bpm'], 100)
                with self.assertRaises(HTTPError) as error:
                    urlopen(base + '/%2e%2e/private.txt')
                self.assertEqual(error.exception.code, 404)
                with self.assertRaises(HTTPError) as error:
                    urlopen(Request(base + '/api/command', data=b'{}', headers={'Origin': 'http://other.example'}))
                self.assertEqual(error.exception.code, 403)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


if __name__ == '__main__':
    unittest.main()
