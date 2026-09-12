# Pi LCD and controls

`lcd.py` presents the shared duet.ai status on LYDIA's 128×48 monochrome LCD and sends physical control events to the same command API as the web UI. It does not start an audio engine, MIDI bridge, network configuration, or any vendor application.

Launch after the API is listening (adjust the checkout path):

```sh
/home/test/Desktop/LYDIA/.venv/bin/python /home/test/backline-pi/services/pi/lcd.py
```

Run as `test`, whose existing GPIO/SPI permissions and LYDIA virtual environment were verified on this Pi. `DUET_API_URL` defaults to `http://127.0.0.1:8088`. `DUET_LCD_FONT` defaults to `/home/test/Desktop/LYDIA/assets/font5x8.bin`. Equivalent CLI overrides are `--url` and `--font`. The vendor environment supplies `board`, `busio`, `digitalio`, `adafruit_st7565`, `mido`, and its ALSA backend. No vendor Python application modules are imported.

Keep PiMorpho and LYDIA's original display process stopped while running this client. Keep `bento_ttymidi` active: this client opens its existing ALSA input and never writes MIDI or opens the serial device. It retries missing input ports every two seconds. `--no-midi` disables physical controls.

| Physical control | Action |
| --- | --- |
| Encoder A | Intensity, ±5 percentage points |
| Encoder B | Creativity, ±5 percentage points |
| Encoder C | Tempo, ±1 BPM (40–240) |
| Encoder D | Select drums, bass, keys, or lead |
| SELECT rotation | Cycle lofi, funk, rock, jazz |
| SELECT push | Toggle selected instrument |
| Left/down footswitch | Play/pause |
| Right/up footswitch | Return tempo to automatic detection |

Mapping follows vendor CC assignments: SELECT 20/21, A 22/23, B 24/25, C 26/27, D 32/33, SELECT push 28, feet 64/65. Button press is value 64; release is value 0. Held presses are deduplicated. The client polls status four times per second and consumes MIDI between polls. It drops commands while the API is unavailable and displays `OFFLINE` with `API unavailable`; no delayed commands replay after reconnect. An API response with `online: false` also shows `OFFLINE` / `Browser disconnected` and suppresses physical commands until browser status is fresh. Unknown musical values remain `--`.

The six display rows show transport, genre/engine, tempo/key/chord, intensity/creativity and enabled instruments (`D B K L`), input meter and lock, then selection or errors. `AUDIO WAIT` reports suspended browser audio. Display writes only occur when visible content changes.

For development without a Pi:

```sh
cd services/pi
python3 -m unittest test_lcd.py
python3 lcd.py --fake --no-midi --seconds 2
```

`--seconds 2` bounds a real hardware check too. Zero (default) runs until SIGTERM or Ctrl+C.

Validation on LYDIA: a two-second run using the existing virtual environment initialized the real ST7565 driver, rendered the offline screen, opened `bento_ttymidi:MIDI out 128:0`, and exited cleanly. The bridge remained PID 853; PiMorpho remained stopped. This proves successful display-driver communication and MIDI subscription; physical knob/foot operation and visual panel legibility still need a person at the device. No persistent service was started by this test.
