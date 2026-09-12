# One UI for browser playback and Pi control

The public app and Pi controller both render src/ui/live.ts with the same CSS.
The old services/pi/control.html implementation is removed. The Pi server redirects
its root and legacy control.html URL to /backline/?control=pi.

The bootstrap loads either the browser audio application or a small remote action
adapter. LAN clients of the Pi build automatically select remote control; only the
loopback kiosk starts the Pi audio runtime. Remote control reads the Pi's complete
AppState and forwards LiveActions to its existing command queue. It never starts
microphone capture, MIDI input, an accompaniment engine, or local audio playback.

The shared header identifies the playback destination. Pi capabilities restrict the
sound list to installed samples. Remote transport can pause/resume Pi playback;
key override now has a validated Pi command, alongside all existing controls.
Status errors disable remote controls, slider updates are coalesced, and ambiguous
failed toggles are not replayed. Legacy flat status fields remain for the LCD.

Checks: shared renderer/action tests, Pi status mapping/disconnection tests, key
command validation and HTTP redirect integration, full frontend suite, both builds,
and live browser checks after deployment.

Live Pi check at 390px: root redirected into the shared app, no horizontal
overflow, six installed sounds, and the shared amount control reached the Pi.
Separating the sound catalog from the audio implementation keeps the remote bundle
free of audio-engine imports; browser instrumentation checks AudioContext creation,
MIDI requests and whether the local main module loaded.
