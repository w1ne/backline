# duet.ai on LYDIA

One codebase produces two editions. `npm run build` creates the public web app
in `dist/`; its existing relay settings and hosting workflow are unchanged.
`npm run build:pi` creates `dist-pi/` with `.env.pi`: offline synth sounds,
Patterns by default, physical LYDIA audio, and a local AMT endpoint.
Never upload `dist-pi/` to public hosting.

## Use the installed pedal

Open **http://172.16.22.3:8088/** on WiFi@Berghotel, or
**http://192.168.10.1:8088/** on the LYDIA Ethernet network.
The Wi-Fi profile `duet-venue-wifi` reconnects automatically; its DHCP address may change.
This page controls the pedal; capture and playback happen on the Pi itself.
Play a steady phrase to establish tempo, or select a manual tempo to start.
The default accompaniment enables drums, bass and keys. Enable lead if you want
short answering phrases in gaps. AMT needs performer notes before it generates.

The Pi desktop opens the local app automatically. The small LCD displays status
and accepts the existing knobs and footswitches; see [LCD.md](LCD.md).
Remote desktop remains available through the existing VNC server.

## Deploy from the development computer

```bash
npm ci
bash services/pi/deploy.sh test@192.168.10.1
```

The script builds the Pi edition, copies it under `/home/test/duet-ai`, and
installs the web, Chromium, and LCD systemd services. SSH authentication is
provided interactively or through your SSH agent/control connection, not stored
in the project. This deployment replaces PiMorpho at boot. Vendor firmware and
the `bento_ttymidi` hardware bridge remain installed.

Local AMT is an optional separate installation under `/home/test/duet-ai-model`.
Its dependencies, checkpoint and shared source files are documented in
[the benchmark and installation notes](../../docs/pi-amt-benchmark/README.md).
A frontend deployment does not install or update that model environment.

## Services and recovery

```bash
systemctl status duet-web duet-browser duet-lcd duet-amt
curl http://127.0.0.1:8088/health
curl http://127.0.0.1:8088/api/status
sudo systemctl restart duet-web duet-browser duet-lcd
```

The controller binds port 8088 on the device network. Runtime status writes,
command consumption, Chromium debugging on port 9222 and AMT on port 18081 are loopback-only.
The device controller is intended for this trusted local network.

To return audio and boot ownership to the original installation:

```bash
bash /home/test/duet-ai/services/pi/restore-morpho.sh
```

Chromium uses its own profile with local MIDI permission and unattended audio
permission. The `--use-fake-ui-for-media-stream` flag accepts the permission
dialog; capture still uses the real LYDIA input. No fake capture device is used.

## Validation

Run `npm test`, both build commands, and:

```bash
python3 -m unittest discover -s services/pi -p 'test_*.py'
```

AMT tests require its isolated PyTorch environment and are skipped when PyTorch
is absent. They are also run on the Pi. Hardware validation covered real capture,
nonzero playback through the LYDIA sink, local controller commands, LCD driver
initialization and browser restart. A person at the pedal must still judge sound
quality and physical control feel; timing tests cannot establish either.

The final end-to-end check sent 40 performer notes through a temporary ALSA MIDI
port at 100 BPM. The Pi detected the melody/key, the browser received local AMT
plans and scheduled keys/bass without JavaScript errors or late-note drops in
that short run. See `docs/pi-amt-benchmark/browser-midi-check.json`. Longer
concurrent benchmarks did show occasional late or empty windows, so AMT remains
experimental. Patterns is restored to automatic tempo listening after testing.
Wi-Fi reachability and internet HTTPS were checked from the installed Pi.
