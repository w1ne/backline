#!/usr/bin/env python3
"""duet.ai's small Pi display and MIDI controls; no audio or vendor services."""
from __future__ import annotations

import argparse
import json
import math
import os
import signal
import time
import urllib.request

GENRES = ('lofi', 'funk', 'rock', 'jazz')
INSTRUMENTS = ('drums', 'bass', 'keys', 'lead')


def number(value, default=0):
    try:
        result = float(value)
        return result if math.isfinite(result) else default
    except (TypeError, ValueError):
        return default


def status_lines(status, error='', selected='drums'):
    """Six ASCII rows, 21 columns (the physical panel is 128 x 48)."""
    error = error or ('Browser disconnected' if status.get('online') is False else '')
    mode = 'OFFLINE' if error else ('PLAY' if status.get('power') == 'on' else 'READY')
    if status.get('audioSuspended') and not error:
        mode = 'AUDIO WAIT'
    bpm = status.get('bpm')
    tempo = str(round(number(bpm))) if bpm is not None else '--'
    enabled = status.get('enabled') or {}
    band = ' '.join(name[0].upper() if enabled.get(name) else '-' for name in INSTRUMENTS)
    level = min(7, max(0, round(number(status.get('inputLevel')) * 7)))
    warning = error or status.get('error')
    lines = [
        f'duet.ai {mode}',
        f"{status.get('genre', '--')} / {status.get('engine', '--')}",
        f"{tempo} BPM {status.get('key') or '--'} {status.get('chord') or '--'}",
        f"I{round(number(status.get('intensity'))*100):3} C{round(number(status.get('creativity'))*100):3} {band}",
        f"{str(status['soundLabel'])[:13]} N{number(status.get('noiseVolume')):.2f}" if status.get('soundLabel') else f"IN {'|'*level}{'.'*(7-level)} {'LOCK' if status.get('locked') else 'AUTO'}",
        str(warning) if warning else f'> {selected} SELECT toggle',
    ]
    return [line.encode('ascii', 'replace').decode()[:21] for line in lines]


class FakeDisplay:
    def __init__(self, verbose=False):
        self.lines, self.frames, self.verbose = [], 0, verbose

    def fill(self, color):
        self.lines = []

    def text(self, text, x, y, color, **kwargs):
        self.lines.append(text)

    def show(self):
        self.frames += 1
        if self.verbose:
            print('\n'.join(self.lines), flush=True)


def create_display():
    # Match the working LYDIA wiring/settings without importing its application,
    # whose modules start networking and MIDI functionality.
    import board
    import busio
    import digitalio
    import adafruit_st7565
    spi = busio.SPI(board.SCLK, MOSI=board.MOSI)
    dc = digitalio.DigitalInOut(board.D27)
    cs = digitalio.DigitalInOut(board.CE0)
    reset = digitalio.DigitalInOut(board.D17)
    display = adafruit_st7565.ST7565(spi, dc, cs, reset)
    display.write_cmd(display.CMD_SET_BIAS_7)
    display.write_cmd(display.CMD_SET_ADC_NORMAL)
    display.write_cmd(display.CMD_SET_COM_REVERSE)
    display.contrast = 12
    display.start_bytes = 0
    return display


def render(display, status, error='', selected='drums', font=None):
    display.fill(0)
    for row, line in enumerate(status_lines(status, error, selected)):
        kwargs = {'font_name': font} if font else {}
        display.text(line, 0, row * 8, 1, **kwargs)
    display.show()


class Client:
    def __init__(self, base_url):
        self.base_url = base_url.rstrip('/')

    @staticmethod
    def validate_status(value):
        if not isinstance(value, dict):
            raise ValueError('Invalid API status')
        return value

    def request(self, path, command=None):
        body = None if command is None else json.dumps(command).encode()
        request = urllib.request.Request(self.base_url + path, data=body,
                                         headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=.5) as response:
            return json.loads(response.read(65536))

    def status(self):
        return self.validate_status(self.request('/api/status'))

    def command(self, command):
        self.request('/api/command', command)


class ControlMapper:
    def __init__(self):
        self.held = set()
        self.selected = 0

    def command(self, cc, value, status):
        if cc in (28, 64, 65):
            if value == 0:
                self.held.discard(cc)
                return None
            if value != 64 or cc in self.held:
                return None
            self.held.add(cc)
            if status.get('online') is False:
                return None
            if cc == 64:
                return {'type': 'transport', 'playing': status.get('power') != 'on'}
            if cc == 65:
                return {'type': 'bpm', 'bpm': None}
            return {'type': 'toggle', 'instrument': INSTRUMENTS[self.selected]}
        if status.get('online') is False or value <= 0:
            return None
        if cc in (22, 23, 24, 25):
            field = 'intensity' if cc in (22, 23) else 'creativity'
            step = .05 if cc % 2 == 0 else -.05
            value = round(max(0, min(1, number(status.get(field), .5) + step)), 2)
            return {'type': 'set', 'field': field, 'value': value}
        if cc in (26, 27):
            value = round(max(40, min(240, number(status.get('bpm'), 100) + (1 if cc == 26 else -1))))
            return {'type': 'bpm', 'bpm': value}
        if cc in (20, 21):
            genre = status.get('genre')
            idx = GENRES.index(genre) if genre in GENRES else 0
            return {'type': 'set', 'field': 'genre', 'value': GENRES[(idx + (1 if cc == 20 else -1)) % len(GENRES)]}
        if cc in (32, 33):
            self.selected = (self.selected + (1 if cc == 32 else -1)) % 4
        return None


class MidiInput:
    def __init__(self, keyword):
        import mido
        self.mido, self.keyword, self.port, self.retry = mido, keyword.lower(), None, 0
        mido.set_backend('mido.backends.rtmidi/LINUX_ALSA')

    def pending(self):
        try:
            if self.port is None and time.monotonic() >= self.retry:
                self.retry = time.monotonic() + 2
                names = self.mido.get_input_names()
                name = next((name for name in names if self.keyword in name.lower()), None)
                if name:
                    self.port = self.mido.open_input(name)
                    print(f'MIDI controls: {name}', flush=True)
            return list(self.port.iter_pending()) if self.port else []
        except Exception as exc:
            print(f'MIDI reconnecting: {exc}', flush=True)
            self.close()
            return []

    def close(self):
        if self.port:
            self.port.close()
        self.port = None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default=os.getenv('DUET_API_URL', 'http://127.0.0.1:8088'))
    parser.add_argument('--font', default=os.getenv('DUET_LCD_FONT', '/home/test/Desktop/LYDIA/assets/font5x8.bin'))
    parser.add_argument('--fake', action='store_true', help='Print display rows without hardware')
    parser.add_argument('--no-midi', action='store_true')
    parser.add_argument('--seconds', type=float, default=0, help='Bounded test; zero runs until stopped')
    parser.add_argument('--midi-port', default='bento_ttymidi')
    args = parser.parse_args()
    display = FakeDisplay(verbose=True) if args.fake else create_display()
    midi = None
    if not args.no_midi:
        try:
            midi = MidiInput(args.midi_port)
        except (ImportError, RuntimeError) as exc:
            print(f'MIDI controls unavailable: {exc}', flush=True)
    running = True

    def stop(*_):
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    client, mapper = Client(args.url), ControlMapper()
    status, error, next_poll, previous = {}, 'Connecting', 0, None
    deadline = time.monotonic() + args.seconds if args.seconds else float('inf')
    try:
        while running and time.monotonic() < deadline:
            now = time.monotonic()
            if now >= next_poll:
                try:
                    status, error = client.status(), ''
                except Exception as exc:
                    if not error:
                        print(f'API unavailable: {exc}', flush=True)
                    error = 'API unavailable'
                next_poll = time.monotonic() + .25
            for message in midi.pending() if midi else []:
                if message.type != 'control_change':
                    continue
                command = mapper.command(message.control, message.value, status)
                # Consume releases while disconnected, but do not queue stale actions.
                if command and not error and status.get('online') is not False:
                    try:
                        client.command(command)
                        if command['type'] == 'set':
                            status[command['field']] = command['value']
                        elif command['type'] == 'transport':
                            status['power'] = 'on' if command['playing'] else 'off'
                        elif command['type'] == 'bpm':
                            status['bpm'] = command['bpm']
                        next_poll = 0
                    except Exception as exc:
                        print(f'Command failed: {exc}', flush=True)
                        error = 'Command failed'
            selected = INSTRUMENTS[mapper.selected]
            lines = status_lines(status, error, selected)
            if lines != previous:
                render(display, status, error, selected, None if args.fake else args.font)
                previous = lines
            time.sleep(.05)
    finally:
        if midi:
            midi.close()
    print('LCD stopped', flush=True)


if __name__ == '__main__':
    main()
