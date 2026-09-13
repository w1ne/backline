# duet.ai — submission

Team: duet.ai
Members: Andrii Shylenko, Fabian Schuller, Nafisa A, Liz Shch, Weronika Z, Aboutsue
Challenge: 2 — AI Instruments & Beyond Music
Web app: https://www.duetai.art
Code (MIT): https://github.com/w1ne/duet.ai
Demo video: https://github.com/w1ne/duet.ai/releases/download/hackathon-2026-demo/duetai-demo.mp4

## What it is
An AI band that plays along with a musician in real time. Input is a microphone (voice or instrument) or a MIDI keyboard. After four bars the software locks tempo and key and adds drums, bass, keys and lead. Instruments can be switched on and off, genre and creativity are adjustable.

## Two editions, one codebase
1. Browser app at duetai.art. Runs on laptop and phone, no account, no API key.
2. Standalone program on the Roland/Neutone LYDIA pedal. Runs on the Pi inside the pedal, uses its audio in/out, knobs, footswitches and LCD. Auto-updates from GitHub every 2 minutes.

## How it works
- Listener (browser or pedal): onset detection, pitch tracking, tempo lock, key and chord detection.
- Four accompaniment engines behind one interface:
  - Patterns: rule-based, runs locally, zero latency, works offline.
  - Lyria RealTime (Google): streamed audio, control latency about 0.5 s.
  - ACE-Step 1.5 XL-turbo on our own GPU pod: generates the next 2-bar block.
  - Anticipatory Music Transformer on the same pod: symbolic, follows the played notes, updates every half bar.
- Band behaviour: intensity, space, fills, section changes, chord changes on the downbeat.
- Relay: Cloudflare Worker that holds the API key and pod addresses.
- Any band part can be routed to the LYDIA morph input for timbre transfer.

## Built during the hackathon
Voice listener tested on real singing (MIR-1K: 92 % pitch accuracy, tempo from voice 62 % within 8 %). Four engines wired live. Half-bar planning from one model on the GPU. Chord following. Count-in and tap tempo. Pedal edition with LCD and footswitch control. Phone support.

## Stack
TypeScript, Vite, Tone.js, Cloudflare Workers, RunPod L40S, Python services for ACE-Step and AMT, Raspberry Pi on the LYDIA.
