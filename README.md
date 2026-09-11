# Backline

Backline is a virtual backing band: play into a mic or MIDI keyboard, and after
four bars it locks onto your tempo and key and starts playing drums, bass,
keys, and a lead alongside you. Design spec:
https://shylenko.com/backline/spec/

## Try it

https://shylenko.com/backline/ — use headphones (the app listens through the
mic, so speaker playback feeds back into the tempo/key detection). Choose mic
or MIDI as input and play four bars; the app locks tempo and key from that.
On the live screen you can toggle each of the four instruments (drums, bass,
keys, lead) on or off, changes land on the next bar; switch genre (lofi,
funk, rock, jazz); adjust the Creativity slider (0 to 1, how far the band
strays from its written patterns); and pick Locked or Follow tempo mode
(Locked keeps the BPM fixed after the four-bar lock, Follow keeps
re-estimating it from your playing, clamped and ramped so it never jumps).

## Engines

- **Patterns** (`src/engines/patternEngine.ts`) — offline, rule-based pattern
  banks played through Tone.js. No network, no external dependency, zero
  control-change latency, always in key. This is the default and the one
  used for the Follow tempo mode.
- **Lyria** (`src/engines/lyriaEngine.ts`) — Google's Lyria RealTime model,
  reached through our Cloudflare Worker relay so the API key never goes to
  the browser. Sign in with GitHub; only collaborators on `w1ne/backline` are
  let through. Measured on 2026-09-11: about 3 s to first audio; a control
  change (toggle, genre, creativity) lands audibly about 0.5 s later because
  the engine resets context and crossfades the seam; audio delivery ran at
  roughly 0.75x real time, so expect occasional stalls or catch-up. Magenta
  RealTime 2 on Apple Silicon is planned as the live-quality engine once
  benchmarked (see `bench/mrt2/README.md`).

## Develop

```sh
npm i
npm run dev
npm test
npm run build
```

Deploy is push to `main`.

## Layout

- `src/listener/` — mic/MIDI input, onset and pitch detection, tempo lock and follow, key detection.
- `src/band/` — the clock and bandleader that drive bars and schedule instruments.
- `src/patterns/` — per-genre note patterns (lofi, funk, rock, jazz).
- `src/players/` — Tone.js sound sets that turn scheduled notes into audio.
- `src/engines/` — the two `BandEngine` implementations (patterns, Lyria).
- `src/ui/` — the two app screens (setup, live) and app state.
- `src/music/` — scales and key helpers shared across the above.

## Add a genre

Copy `src/patterns/lofi.ts` to a new file, adjust the drum/bass/keys/lead
patterns, register it in `src/patterns/index.ts` (add it to the `Genre` type
and the `PATTERNS` map), and add a short test using `genreContract` (see the
existing `*.test.ts` files in `src/patterns/`) — two lines is enough to check
it produces notes in key at creativity 0.

## Change sounds

Edit `src/players/soundsets.ts` — one `SoundSet` (drums, bass, keys, lead) is
built per genre from Tone.js instruments or samples.

## Relay deploy

See `relay/README.md` for deploying the Cloudflare Worker (GitHub OAuth app
setup, secrets, endpoints).

## Demo tips

Use headphones. Try MIDI input first — it locks tempo and key more reliably
than the mic in a noisy room. On venue Wi-Fi, stick to the Patterns engine;
it needs no network, unlike Lyria.

## Licenses / attribution

Tone.js is MIT licensed. Magenta RealTime 2 model weights are CC-BY-4.0;
if that engine is used, attribution is required (see `bench/mrt2/README.md`
for the citation text).
