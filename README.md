# Backline

A band in the browser that plays along with you. Play into the mic or a MIDI keyboard; after four bars Backline locks onto your tempo and key and plays drums, bass, keys and lead in that key. Toggle instruments, switch genre, turn the Creativity knob. Everything runs from one panel.

Live: https://shylenko.com/backline/ (soon https://soundofthe.world). Spec with mockups: https://shylenko.com/backline/spec/

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
- **UI** (`src/ui/`): vanilla DOM, hardware-panel look. Power key, LCD status, four pads, knob, genre chips, engine switch, manual BPM/key.

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
