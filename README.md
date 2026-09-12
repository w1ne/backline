# duet.ai

A band in the browser that plays along with you. Play into the mic or a MIDI keyboard; after four bars duet.ai locks onto your tempo and key and plays drums, bass, keys and lead in that key. Toggle instruments, switch genre, turn the Creativity knob. Everything runs from one panel.

Live: https://shylenko.com/backline/ (soon https://soundofthe.world). Spec with mockups: https://shylenko.com/backline/spec/

## Run locally

macOS or Linux, Node 18+:

```sh
scripts/run-local.sh            # app at http://localhost:8088/backline/, hosted relay
scripts/run-local.sh --relay    # also runs the relay on :8787 (needs GEMINI_API_KEY)
```

The Patterns engine needs nothing else. `--relay` reads `GEMINI_API_KEY` from the environment or `~/.local/secrets/gemini.env`, and picks up `ACESTEP_UPSTREAM` / `AMT_UPSTREAM` if set, so the Lyria, ACE and AMT engines work against your own keys and pods.

## How it works

```
mic / MIDI  →  Listener  →  { bpm, key, chord, notes }  →  BandEngine  →  audio
```

- **Listener** (`src/listener/`): onset detection with an adaptive noise floor, McLeod pitch detection, tempo lock from 12 onsets (two-stage IOI estimate), Krumhansl–Schmuckler key detection, chord detection, Follow mode (±8 % per bar, ramped). Mic and MIDI feed the same lock.
- **BandEngine** (`src/engines/`): one interface, three implementations, switchable on the panel.

| Engine | Where it runs | Latency of a control change | Notes |
|---|---|---|---|
| Patterns | in the browser (Tone.js) | next bar | rule-based pattern banks per genre; no network; the fallback |
| Lyria | Google Lyria RealTime via the relay | ~0.5 s (reset + 150 ms crossfade) | measured delivery ~0.8× real time; the player loops the last bar when starved |
| ACE | ACE-Step 1.5 on a GPU pod via the relay | next 2-bar block | generates the next block one block ahead (~2.3 s per 4.8 s block on an L4); continuous, no stalls |

- **Relay** (`relay/`): Cloudflare Worker. Holds the API key and the pod URL, proxies the WebSockets, accepts connections only from the app's origins, 6 new connections per minute per IP. No accounts.
- **UI** (`src/ui/`): vanilla DOM, hardware-panel look. Power key, LCD status, four pads, knob, genre chips, engine switch, manual BPM/key, mic/MIDI input pickers and the MORPH output.
- **Morph bus** (`src/audio/`): a second audio output for a hardware timbre-transfer box — see [Neutone / LYDIA](#neutone--lydia).

### Chord following

`src/listener/chordDetector.ts` keeps a decaying pitch-class histogram over the last two beats — bass notes count 1.5×, because the bass note names the chord — and matches it against 84 templates (major, minor, dom7, min7, maj7, sus4, dim on all twelve roots). The score is the cosine similarity with the template minus the share of energy on non-chord tones, which is what keeps C–E–G reading as C rather than as a Cmaj7 missing its seventh.

The chord is only *re-decided* when the app clock calls `Listener.tickChord()`, on the bar and the half bar — not per note, so the band hears at most two chords a bar. A new chord has to clear 0.55 confidence *and* either beat the incumbent by 0.1 or catch it below 0.4; that hysteresis is what stops the flicker between a triad and its relative. Until something settles, the band plays the key's tonic triad.

What each engine does with it:

| Engine | On a chord change |
|---|---|
| Patterns | bass and keys resolve their degrees against the chord instead of the key, from the next bar (and from the next half bar for hits that land after the change). Passing tones still come from the key, so a secondary dominant brings only its own third out of key |
| ACE | the last four chords ride along in the block request as `chords: ['Am','F','G','C']` and the server names them in the prompt. ACE-Step 1.5 has no structured harmony input past `key_scale`, so this is a nudge, not a constraint — and deliberately does *not* restart the stream the way a key change does |
| Lyria | nothing. Lyria applies harmony by resetting the stream, which costs a reconnect and an audible gap; paying that every half bar is not worth it. Key changes keep the existing reset path |
| AMT | nothing needed — it already follows the player's actual notes. The chord is sent in `set` for the server to use later |

## Neutone / LYDIA

Backline can send chosen parts to a **second** audio output, so a hardware timbre-transfer
box — a Roland/Neutone LYDIA on the interface's outputs — hears only those parts while the
rest of the band stays dry on the laptop's output.

**Hook-up.** Interface outputs 3/4 → LYDIA in → LYDIA out → PA (or back into the interface
on a spare input). Outputs 1/2 stay on the PA as the dry band. Both signals meet in the PA,
not in the browser, so the morphed part has its own level and its own channel.

**Picking the output.** In the MANUAL panel, `MORPH OUT` lists every output device the OS
reports (built-in, HDMI, the interface's output pairs); "off" turns the morph bus off again.
The choice is remembered. It needs `setSinkId()`, which today means Chrome or Edge — the
picker disables itself and says so in any other browser. Device names only appear after the
mic permission has been granted, so power the app on once if the list reads "Output 1/2/3".

**What to morph.** The small **M** key on each pad cycles that instrument through
main → morph → both (grey LED / pink / half-and-half). `BAND → MORPH` does the same for the
generated stream from Lyria and ACE, as one bus. Choosing an output for the first time puts
**keys and lead** on it, which is what these models are good at: sustained, pitched, one voice
at a time. Drums do not survive timbre transfer, and bass loses its bottom. `both` is for
auditioning — dry and morphed at once.

**Latency.** The morph path renders into a MediaStream and plays it through a hidden
`<audio>` element, which re-buffers: **~20–50 ms** behind the main output, before LYDIA's own
latency. Against a separate amp that offset is inaudible; in `both` mode it is a short,
audible doubling, so use `both` to choose a sound and not to play a set.

## Mic and MIDI inputs

`MIC IN` picks which input device the Listener hears (the interface, not the laptop's built-in
mic, is usually what you want); echo cancellation, noise suppression and AGC are off on every
device, since all three fight onset detection. Switching mid-song restarts only the audio
stream — the tempo lock, key and chord survive it.

`MIDI IN` lists the connected keyboards by name and defaults to "all". The LCD names the ones
it is listening to (`MIDI ✓ Minilab3 MIDI`). An Arturia MiniLab 3 is class-compliant USB MIDI:
no driver needed, and it can be plugged in before or after Power — hot-plug is handled. Chrome
asks for MIDI permission the first time, and that prompt has to be accepted or the keyboard
never appears in the list.

## Run it

```sh
npm i
npm run dev        # http://localhost:5173/backline/
npm test           # vitest, 150+ tests, no audio needed
npm run build
```

Push to `main` deploys to GitHub Pages (shylenko.com/backline/) and Cloudflare Pages (soundofthe.world). Any other branch deploys a preview at `https://<branch>.backline-88n.pages.dev`.

## GPU service

`services/acestep/` is the ACE-Step block server (FastAPI, one WebSocket per session: JSON block requests in, PCM16 48 kHz blocks out). `services/acestep/README.md` has the RunPod recipe; `DEPLOYED.md` records the current pod. The relay reads the pod URL from the `ACESTEP_UPSTREAM` secret, so moving the pod is one `wrangler secret put`.

`bench/` holds the benchmark kits and results for Lyria, Magenta RealTime 2 (Apple Silicon path, not yet run) and ACE-Step.

## Extend

- New genre: copy `src/patterns/lofi.ts`, register it in `src/patterns/index.ts`, add a two-line test with `genreContract`.
- New sounds for the Patterns engine: `src/players/soundsets.ts`.
- New engine: implement `BandEngine` (`src/engines/engine.ts`) and add a switch position in `src/ui/live.ts`.

## Demo notes

Headphones. MIDI is the most reliable input in a loud room. Patterns works with no network; ACE and Lyria need the relay and, for ACE, a running pod.

## Licences

MIT for this repo. Tone.js MIT. ACE-Step 1.5 MIT (code and weights). Magenta RealTime 2 weights CC-BY-4.0 if used.

### LYDIA / Raspberry Pi edition

The public web app and the pedal share the same music engine code. The pedal has
its own offline build (`npm run build:pi`), local audio, LCD controls and optional
local AMT model. See [Pi installation and controls](services/pi/README.md).
The normal web build (`npm run build`) remains separate.
