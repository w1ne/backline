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

## Why it is technically hard

1. Real-time audio understanding in the browser. Pitch (McLeod/NSDF), onsets, tempo and key are computed from a raw microphone stream in a Web Audio worker. A solo voice has no beat, so tempo comes from an autocorrelation tempogram of the spectral flux with a log-Gaussian prior and octave folding. Measured on 110 MIR-1K songs: 62 % within 8 % of the true tempo, versus 44–47 % for librosa and 40 % for madmom. Pitch accuracy 92 %, note F1 0.68, key locked on 19 of 24 test songs.
2. Chord following from monophonic input. A singer gives one note at a time. A harmoniser over diatonic triads with hysteresis and a tonic tie-break turns a 1.5-bar window of sung pitches into a chord, and the band changes chord on the downbeat.
3. Four generative engines behind one interface, all live: rule-based patterns (Tone.js), Google Lyria RealTime (streamed PCM over WebSocket), ACE-Step 1.5 XL-turbo (4B DiT, 2-bar blocks generated in 1.2 s on an L40S), and the Anticipatory Music Transformer (symbolic, note-following). Each engine has a different latency and control model; the app keeps them on one musical clock.
4. Scheduling under deadline. Every note is scheduled against the AudioContext clock, corrected for output latency, with a tempo-aware deadline. The GPU pod returns a plan every half bar (about 220 ms p50 with five instruments, one masked sampling pass per instrument). Late plans are dropped and counted, not played late.
5. One "brain" on the GPU. The AMT service owns chord, section and dynamics (intensity, space, fills), so all engines play the same song form.
6. Infrastructure. A Cloudflare Worker relay holds the API key and pod addresses, gates on origin, rate limits, proxies WebSockets (including a binary-frame bug workaround), and reports per-engine health. Pod bootstrap, watchdog, and a smoke test through the relay are scripted.
7. Same code on a pedal. The LYDIA edition runs on a Raspberry Pi with ALSA audio, an LCD, knobs and footswitches, and updates itself from a rolling GitHub release every 2 minutes with no Node or git on the device.
8. Measured, not guessed. Benches for pitch, tempo, real-voice key clash and empty-plan rate are in the repo and run in CI. The key-clash gate rejected two changes during the hackathon.
