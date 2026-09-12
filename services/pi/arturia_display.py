"""Mirror keyboard sound and noise level to the MiniLab 3's own screen.

Protocol reference (display-only messages):
https://gist.github.com/Janiczek/04a87c2534b9d1435a1d8159c742d260
"""
import json
import time
import math
from urllib.request import urlopen

HEADER = [0, 32, 107, 127, 66]
DISPLAY_INIT = HEADER + [2, 2, 64, 106, 33]


def display_payload(top, bottom):
    def clean(value):
        return [ord(c) if 32 <= ord(c) < 127 else 32 for c in str(value)[:16]]
    return HEADER + [4, 2, 96, 1] + clean(top) + [0, 2] + clean(bottom) + [0]


def display_lines(status):
    if not status.get('online'):
        return 'duet.ai', 'Disconnected'
    noise = float(status.get('noiseVolume', 0))
    noise = min(1, max(0, noise)) if math.isfinite(noise) else 0
    sound = str(status.get('soundLabel', 'Keyboard')).replace(' (built-in)', '')
    return f'duet.ai N{noise:.2f}', sound


def main():
    import mido
    port = None
    previous = None
    last_sent = 0
    try:
        while True:
            try:
                if port is None:
                    names = [n for n in mido.get_output_names() if 'minilab3 midi' in n.lower()]
                    if not names:
                        time.sleep(1)
                        continue
                    port = mido.open_output(names[0])
                    port.send(mido.Message('sysex', data=DISPLAY_INIT))
                    print('MiniLab display connected: ' + names[0], flush=True)
                    previous = None
                try:
                    with urlopen('http://127.0.0.1:8088/api/status', timeout=1) as response:
                        status = json.load(response)
                except (OSError, ValueError):
                    status = {'online': False}
                lines = display_lines(status)
                if lines != previous or time.monotonic() - last_sent > 1:
                    port.send(mido.Message('sysex', data=display_payload(*lines)))
                    if lines != previous:
                        print('Display: ' + ' | '.join(lines), flush=True)
                    previous = lines
                    last_sent = time.monotonic()
                # Reopen after unplug/replug even when ALSA silently accepts old writes.
                if port.name not in mido.get_output_names():
                    port.close()
                    port = None
                time.sleep(.15)
            except (OSError, RuntimeError, ValueError) as error:
                print('Display retry: ' + str(error), flush=True)
                if port:
                    port.close()
                port = None
                time.sleep(1)
    finally:
        if port:
            port.close()


if __name__ == '__main__':
    main()
