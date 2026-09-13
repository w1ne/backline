# Voice-only release smoke

Run `npm run smoke:voice` with Chrome/Chromium installed (`CHROME_BIN` can name its
executable). The script builds the app into a temporary directory, runs a local
HTTP/WebSocket AMT fixture, and opens the real interface in headless Chrome. No
production relay, GPU, paid inference service or external sample CDN is contacted.
Production's sample preparation helper supplies the integrity-checked violin asset
used by this fixture; the full production build prepares all instruments separately.

The microphone input is a generated sustained harmonic A4 WAV, not an injected
listener event. The test clicks Enable sound using the normal browser autoplay
policy, leaves the default count-in enabled, and never taps or sets BPM. It disables
drums and checks that monitoring, drone and noise are off. The fixture emits GM
violin plans only after it receives the actual held microphone note and the
listening window has elapsed. An analyser attached to the real master audio output
must measure sound after count-in; scheduling callbacks alone cannot pass.

The 20-second observation also checks that sustained input stays active beyond the
old false-ending threshold. A disconnected MIDI stub keeps the scenario voice-only
regardless of the host's attached hardware. Artifacts (state, wire input, plans,
audio peaks, browser errors and screenshot) go to `test-results/voice-smoke/`.
Nonessential external font and inactive keyboard/pattern sample requests are blocked
and logged; the AMT instrument must load locally and produce sound despite that.
The production deploy workflow runs this gate before either deployment job can run.

To verify the gate itself, `VOICE_SMOKE_FAULT=samples npm run smoke:voice` must fail
because samples return 503, and `VOICE_SMOKE_FAULT=held npm run smoke:voice` must fail
because the fixture ignores held input. These modes never change application code.

This gate covers capture, startup, transport, protocol and sampled playback. It
does not assess the musical quality or availability of live AMT inference, nor does
headless desktop Chrome replace testing on a physical Android device.
