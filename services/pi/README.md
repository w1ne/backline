# duet.ai on LYDIA

One codebase produces two editions. `npm run build` creates the public web app
in `dist/`; its existing relay settings and hosting workflow are unchanged.
`npm run build:pi` creates `dist-pi/` with `.env.pi`: offline synth sounds,
local AMT by default, physical LYDIA audio, and a local AMT endpoint.
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
experimental. The Pi now starts with AMT and does not automatically switch to Patterns when
AMT has no output. Patterns remains a manual option in the controller.
Wi-Fi reachability and internet HTTPS were checked from the installed Pi.

## Arturia MiniLab 3

The large black encoder directly under the MiniLab screen cycles Grand piano,
Electric piano, Hammond organ, Nylon guitar, String ensemble and Vibraphone.
The piano uses Splendid Grand samples with velocity layers; the other five use
Musyng Kite soundfonts. `fetch-samples.mjs` downloads the 31 MB bank on the build
computer before deployment, including attribution. The Pi serves it locally
without internet. Sounds preload and remain cached; switching waits for readiness
and ignores stale loads. LYDIA's LCD and the network controller show the name.
Arturia/User controls (CC114/74/71/76) and DAW controls (CC28/86/87/89) work.
Use DAW mode for the Arturia screen; the performer confirmed its text is visible.
The MiniLab's own screen also shows the instrument and noise level through
`duet-arturia.service`, which sends bounded display-only SysEx messages over
the MiniLab MIDI output and reconnects after hotplug.
Protocol reference: https://gist.github.com/Janiczek/04a87c2534b9d1435a1d8159c742d260

Controller 0 is the large black instrument-selection knob.
Encoder 1 (CC74) sets independent white-noise volume 0–1 (silent at 0). Audio gain is 0.1 × volume², so full scale equals the old 10% gain, encoder 2 (CC71/DAW CC87) drone volume, and encoder 3
(CC76) manual tempo 60–160 BPM. The first fader does not select instruments.
Program changes 0–5 also select the six sounds. Ordinary notes and sustain do
not trigger control commands; the Arturia controls never pause the app or
change the selected AMT engine. Unplugging/reconnecting is supported.

The CC assignments are documented in Arturia's MIDI implementation chart:
https://support.arturia.com/hc/en-us/articles/6189475866396-MiniLab-3-General-Questions
CC114 values64/65/66 were captured from the attached keyboard during testing.

At tempos above 110 BPM the Pi AMT plans two bars with two bars of lead,
every other bar. This trades a longer response delay for time to finish CPU
inference. Padding is relative to retained history so inference does not grow
slower merely because a session has run longer. Web AMT retains one-bar planning.

Rotary 2 controls a continuous low triangle drone, following the detected tonic
with a short pitch glide. It starts silent; volume uses a gentle squared curve
and mutes when transport pauses. The Arturia display shows N (noise) and D (drone).
