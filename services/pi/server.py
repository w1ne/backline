"""Small local host/control plane. Audio runs only in the Pi's Chromium renderer."""
import argparse
from collections import deque
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import math
from pathlib import Path
import threading
import time
from urllib.parse import parse_qs, urlparse
import uuid

INSTRUMENTS = {'drums', 'bass', 'keys', 'lead'}


def validate_command(command):
    if not isinstance(command, dict):
        raise ValueError('Expected an object')
    kind = command.get('type')
    if kind == 'set':
        field, value = command.get('field'), command.get('value')
        if field in ('intensity', 'creativity', 'noiseVolume', 'droneVolume'):
            if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1:
                raise ValueError('Value must be between 0 and 1')
        elif field == 'sound':
            if value not in ('grand', 'electric_piano_1', 'drawbar_organ', 'acoustic_guitar_nylon', 'string_ensemble_1', 'vibraphone'):
                raise ValueError('Unknown keyboard sound')
        elif field == 'genre':
            if value not in ('lofi', 'funk', 'rock', 'jazz'):
                raise ValueError('Unknown genre')
        elif field == 'engine':
            if value not in ('patterns', 'amt', 'acestep'):
                raise ValueError('Unknown local engine')
        else:
            raise ValueError('Unknown setting')
        return dict(type=kind, field=field, value=value)
    if kind == 'toggle' and command.get('instrument') in INSTRUMENTS:
        return dict(type=kind, instrument=command['instrument'])
    if kind == 'transport' and type(command.get('playing')) is bool:
        return dict(type=kind, playing=command['playing'])
    if kind == 'mic' and type(command.get('muted')) is bool:
        return dict(type=kind, muted=command['muted'])
    if kind == 'key':
        key = command.get('key')
        if key is None:
            return dict(type=kind, key=None)
        if isinstance(key, dict) and type(key.get('root')) is int and 0 <= key['root'] <= 11 and key.get('mode') in ('major', 'minor'):
            return dict(type=kind, key=dict(root=key['root'], mode=key['mode']))
    if kind == 'bpm':
        bpm = command.get('bpm')
        if bpm is None or (type(bpm) in (float, int) and math.isfinite(bpm) and 40 <= bpm <= 240):
            return dict(type=kind, bpm=bpm)
    raise ValueError('Invalid command')


class DeviceState:
    def __init__(self):
        self.lock = threading.Lock()
        self.queue = deque()
        self.next_id = 1
        self.epoch = uuid.uuid4().hex
        self.status = {}
        self.updated = 0

    def enqueue(self, command):
        command = validate_command(command)
        with self.lock:
            if len(self.queue) >= 128:
                raise OverflowError('Device is not consuming controls')
            command['id'] = self.next_id
            self.next_id += 1
            self.queue.append(command)
            return command['id']

    def commands(self, ack):
        with self.lock:
            while self.queue and self.queue[0]['id'] <= ack:
                self.queue.popleft()
            return list(self.queue)

    def snapshot(self):
        with self.lock:
            return {**self.status, 'online': time.monotonic() - self.updated < 5}

    def publish(self, status):
        with self.lock:
            self.status = status
            self.updated = time.monotonic()


def handler_for(root, state):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(root), **kwargs)

        def log_message(self, *_):
            pass

        def json(self, status, data):
            body = json.dumps(data).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def local(self):
            return self.client_address[0] in ('127.0.0.1', '::1')

        def do_GET(self):
            path = urlparse(self.path)
            if path.path == '/api/status':
                return self.json(200, state.snapshot())
            if path.path == '/api/commands':
                if not self.local():
                    return self.json(403, {'error': 'Renderer endpoint is local only'})
                query = parse_qs(path.query)
                try:
                    ack = int(query.get('ack', ['0'])[0]) if query.get('epoch', [''])[0] == state.epoch else 0
                except ValueError:
                    return self.json(400, {'error': 'Invalid acknowledgement'})
                return self.json(200, {'epoch': state.epoch, 'commands': state.commands(ack)})
            if path.path == '/health':
                return self.json(200, {'status': 'ok', 'edition': 'lydia', 'renderer': state.snapshot()['online']})
            if path.path in ('/', '/control.html'):
                self.send_response(302)
                self.send_header('Location', '/backline/?control=pi')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            return super().do_GET()

        def do_POST(self):
            # Only the same web origin may submit browser controls. Local Python clients
            # have no Origin header and are used by the LCD/control process.
            origin = self.headers.get('Origin')
            if origin and urlparse(origin).netloc != self.headers.get('Host'):
                return self.json(403, {'error': 'Origin does not match device'})
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 16384:
                    raise ValueError('Invalid request size')
                data = json.loads(self.rfile.read(size))
                if urlparse(self.path).path == '/api/status':
                    if not self.local():
                        return self.json(403, {'error': 'Renderer endpoint is local only'})
                    if not isinstance(data, dict):
                        raise ValueError('Expected status object')
                    state.publish(data)
                    return self.json(200, {'ok': True})
                if urlparse(self.path).path == '/api/command':
                    return self.json(202, {'id': state.enqueue(data)})
                return self.json(404, {'error': 'Not found'})
            except (ValueError, TypeError) as error:
                return self.json(400, {'error': str(error)})
            except OverflowError as error:
                return self.json(503, {'error': str(error)})
    return Handler


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--port', type=int, default=8088)
    args = parser.parse_args()
    ThreadingHTTPServer(('0.0.0.0', args.port), handler_for(args.root, DeviceState())).serve_forever()
