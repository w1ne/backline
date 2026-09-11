# Backline v1 design

Public spec page with mockups: https://shylenko.com/backline/

## What it is

A web page. You play into the mic or a MIDI keyboard. After four bars the app locks onto your tempo and key. From then on it holds that tempo and plays drums, bass, keys and a lead in that key, in a chosen genre. Each instrument is a toggle; changes land on the next bar. A Creativity slider (0–1) controls how far the band strays from its written patterns.

Hackathon build: 50 hours, 5+ people, browser only, no network on the critical path.

## In v1

- Input: MIDI (Web MIDI) or mic (Web Audio).
- Tempo from the first 4 bars, then one of two modes (toggle on the live screen):
  - **Locked** (default): BPM fixed after lock.
  - **Follow**: BPM keeps tracking the player. Re-estimated every bar from the last 8 onsets, clamped to ±8% per bar, ramped over one beat so it never jumps.
- Manual BPM override.
- Latency is a hard requirement: audio context `latencyHint: 'interactive'`, no lookahead beyond one bar, measured round-trip (`baseLatency + outputLatency`) shown on the live screen. Target under 30 ms on the demo laptop; over 60 ms is a bug.
- Key detection (major/minor, 12 roots) from notes played; manual override.
- Four instruments: drums, bass, keys, lead. On/off, applied on the next bar.
- Four genres: lofi, funk, rock, jazz. Switchable live, applied on the next bar.
- Creativity slider 0–1, applied on the next bar.
- Screens A (setup) and B (live) from the spec page.
- Deploys to GitHub Pages on push to main.

## Band engines

Two engines behind one `BandEngine` interface, chosen on the setup screen:

- **Lyria RealTime (Gemini API)** — the any-laptop engine. Our listener steers it: bpm, scale (from the detected key), weighted genre/instrument prompts, mute_drums/mute_bass for toggles, temperature+density from Creativity. Measured 2026-09-11: 3 s to first audio, every control change audible ~2.0–2.6 s later (one bar), `resetContext()` ~0.3 s but cuts audio, so the engine resets on every change and crossfades the seam (150 ms): toggles audible in ~0.5 s. Fixed 2 s chunks, ~3 s playback buffer. One session per jam (reconnects hit 429). API key entered by the user (ephemeral tokens don't work with Lyria).
- **Patterns (offline)** — rule-based pattern banks + Tone.js. Zero network, zero change latency, guaranteed in key. Fallback and the tempo-Follow engine.
- **Magenta RealTime 2 on the team M3 Pro** (`bench/mrt2/`) — the live demo engine: ~200 ms control latency and MIDI-pitch conditioning, served over a WebSocket from the Mac. Benchmark first, then it becomes the default when reachable.

## Not in v1

Chord following, replay/export (screen C), mixer, effects, text prompts, multiplayer, any generative model.

## Architecture

Three units, one message between them.

```
Listener ──BandInput──▶ Bandleader ──NoteEvent[]──▶ Players (Tone.js)
```

### Listener (`src/listener/`)

Turns raw input into `BandInput`:

```ts
interface BandInput {
  bpm: number | null;        // null until locked
  key: Key | null;           // null until confident
  notesNow: number[];        // MIDI note numbers heard in the last ~500 ms
  inputLevel: number;        // 0–1 for the meter
}
interface Key { root: number /* 0=C … 11=B */; mode: 'major' | 'minor' }
```

- `MidiSource`: Web MIDI note-on timestamps and note numbers.
- `MicSource`: Web Audio → `OnsetDetector` (spectral flux onsets → timestamps) and `PitchTracker` (autocorrelation pitch per frame → note numbers).
- `TempoLock`: takes onset timestamps; once it has ≥4 bars' worth (≥12 onsets), estimates BPM by inter-onset-interval histogram clustering in 60–180 BPM, locks, and reports the downbeat phase (the timestamp of the first onset). Pure function, tested with synthetic timestamps.
- `TempoFollower`: after lock, in Follow mode, re-runs the same estimator on a sliding window of the last 8 onsets each bar and returns a new BPM clamped to ±8% of the current one. `Clock.setBpm(bpm)` ramps `Transport.bpm` over one beat.
- `KeyDetector`: pitch-class histogram → Krumhansl-Schmuckler correlation against 24 key profiles. Pure function, tested.

### Bandleader (`src/band/`)

- `Clock`: wraps `Tone.Transport`. Starts at the locked BPM, aligned so bar 1 beat 1 falls on the next downbeat after lock. Emits `onBar(barIndex, barStartTime)` one bar ahead (lookahead = 1 bar).
- `Bandleader`: holds `BandState { genre, key, creativity, enabled: Record<Instrument, boolean> }`. On each `onBar`, for each enabled instrument, calls `patterns[genre][instrument].nextBar(ctx)` and schedules the returned `NoteEvent[]` on the Players. State changes take effect at the next `onBar`.

```ts
type Instrument = 'drums' | 'bass' | 'keys' | 'lead';
type Genre = 'lofi' | 'funk' | 'rock' | 'jazz';
interface NoteEvent { time: number /* beats from bar start, 0–4 */; note: number /* MIDI */; duration: number /* beats */; velocity: number /* 0–1 */ }
interface BarContext { bar: number; key: Key; creativity: number; rng: () => number }
interface Pattern { nextBar(ctx: BarContext): NoteEvent[] }
```

### Patterns (`src/patterns/`)

One file per genre exporting `{ drums, bass, keys, lead }: Record<Instrument, Pattern>`.

Patterns are written as steps with a probability each. Creativity `c` scales probabilities: a step with `p` fires when `rng() < p + (1 - p) * c` for optional steps, and core steps (`p = 1`) always fire. Above `c > 0.8`, bass and lead may pick a chromatic passing note with probability `(c - 0.8) * 0.5`. Drums use MIDI notes 36 kick, 38 snare, 42 closed hat, 46 open hat, 49 crash.

Bass and keys are written in scale degrees and transposed via `key`. Lead picks from the pentatonic of the key, with a phrase-shape table per genre.

`rng` is seeded (`mulberry32`) so tests are deterministic.

### Players (`src/players/`)

Tone.js. `Drums`: `Tone.Sampler` with one-shot samples. `Bass`, `Keys`, `Lead`: `Tone.Sampler` with a few pitched samples, or `Tone.PolySynth` as fallback until samples are chosen. One sound set per genre chosen in `soundsets.ts`. Samples are CC0, stored under `public/samples/`.

`Players.schedule(instrument, events, barStartTime)` converts beats to seconds using the clock BPM and calls `triggerAttackRelease`.

### UI (`src/ui/`)

Vanilla TypeScript, no framework. Screen A: input choice, genre, Start. Screen B: tempo, key, genre dropdown, Creativity slider, YOU strip (level + notes), four instrument tiles, Stop. State lives in one `AppState` store; the UI renders from it.

### Testing

Vitest for pure logic: `TempoLock`, `KeyDetector`, every pattern (produces notes in key, respects creativity 0 = deterministic), `Bandleader` scheduling. Audio and UI are tested by hand in the browser.

### Deploy

Vite build → GitHub Pages via `.github/workflows/deploy.yml` on push to `main`. Base path `/backline/`.

## Risks

Mic bleed (use headphones, lock tempo once), loud venue (MIDI is the primary demo input), browser latency (test on the demo laptop day one), toy-like sound (spend time on samples).
