# duet.ai hearts (Arduino UNO Q)

An App Lab app for the UNO Q's 8x13 LED matrix: a heart that pulses with the band.

- `python/main.py` polls the pedal's `/api/status` five times a second and calls the
  sketch's `beat` RPC when something changes (and once per bar to keep the clock aligned).
- `sketch/sketch.ino` owns the animation at ~40 fps with 8 grey levels. Playing: the heart
  grows and brightens on every beat, harder on the downbeat, scaled by energy (band intensity,
  input level, active parts). Listening: slow breathing. Fill bar: small hearts rise.
  Lead answering a gap: sparkles. Pedal unreachable: dim static heart.

## Wiring

USB-C from the UNO Q to the Pi. The Pi's `duet-unoq.service` (`services/pi/unoq-sync.sh`)
waits for the board on `adb`, sets `adb reverse tcp:8088 tcp:8088` so the board reaches the
pedal at `127.0.0.1:8088`, pushes this folder to `/home/arduino/ArduinoApps/duet-hearts` when
the installed build changes, and restarts the app with `arduino-app-cli`. The board needs its
first-time setup done once in Arduino App Lab (board name, password, Wi-Fi is optional).

Manual run on the board: `arduino-app-cli app restart /home/arduino/ArduinoApps/duet-hearts`,
logs with `arduino-app-cli app logs /home/arduino/ArduinoApps/duet-hearts`.

The sketch also provides `demo(seconds)` for a 156 BPM hearts-and-sparkles preview.
`demo(0)` cancels it; durations from 1 to 3600 seconds automatically return to the latest
band state. The normal status poller continues updating that state during the preview.

On early UNO Q firmware, avoid `sinf`, `expf` and `fmodf`: the compiler can link them,
but the dynamic sketch loader cannot resolve them. This renderer uses exported `sin`
and arithmetic phase/decay calculations instead.

## Tests

`python3 -m unittest discover -s services/unoq/python -p 'test_*.py'`
