Good challenge to pick — it's the one where the sponsor tools (LYDIA/Morpho) and a symbolic model can stack into one coherent demo rather than competing for the story.

## The reframe that decides everything

There are four "delays" and teams routinely conflate them:

1. **Input latency** — MIDI is ~1–3 ms. Audio input plus pitch tracking is 20–50 ms and brings failure modes.
2. **Inference latency** — 100 ms to 1 s+. This is what everyone panics about.
3. **Output latency** — soundfont/DAW buffer, 5–20 ms.
4. **Musical latency** — the model cannot react to a note that hasn't been played yet. Unfixable by engineering.

Only #4 is real. #2 is not a latency problem, it's a **scheduling** problem: you hide inference behind a buffer of already-scheduled future notes. The model is always writing a few beats ahead of the playhead, so as long as it returns before the buffer drains, the audience hears zero delay.

The reference design here is ReaLJam (Google DeepMind / Mila, CHI 2025), which is the closest published thing to what you want. It runs a Transformer chord accompanist against a live pianist using "anticipation" — the agent continually predicts how the performance will unfold and visually conveys its plan to the user. Their scheduling protocol is worth stealing wholesale.Two parameters you tune by ear: **lookahead** (how far ahead the model writes, ~4 beats) and **commit** (how much of that is frozen and can't be rewritten, ~2–4 beats). Short commit = more responsive, but the accompaniment twitches and changes chords under the player's fingers. In the ReaLJam study, zero commit produced rapid unnatural chord changes, while 4 beats of commit made the plan noticeably stable. They also found a "listen first" period matters a lot: letting the agent hear 8 beats before it plays anything almost always made the first chord harmonic instead of dissonant.

The other trick worth copying: to generate its own next bars, the model generates **both** the predicted human part and its own part, then throws the predicted human part away. That's how it plans coherently without seeing the future.

## Which model

My recommendation: **Anticipatory Music Transformer** (Thickstun et al., Stanford CRFM), `stanford-crfm/music-small-800k`.

- 128M params, Apache 2.0, loads with plain `AutoModelForCausalLM`, and the `anticipation` package gives you `midi_to_events` / `events_to_midi` and a custom `generate`.
- It was built for exactly your control pattern: you give it part of a composition and it infills the rest, including melody-in / accompaniment-out.
- Small enough to run locally on your Mac via MPS, which removes network round-trips entirely.

Things to know before committing: it's trained on Lakh MIDI, so its default idiom is generic pop/MIDI-corpus, and it was designed for *offline* infilling. Nobody has published it running online. That's your technical contribution and also your risk.

The fallback ladder, in order of how much you should want to descend it:
- `music-medium-800k` if small sounds too dumb and you have GPU headroom.
- A rule-based accompanist (chord detection from recent notes + voicing + rhythm pattern). Build this anyway — see below.

Don't reach for ReaLchords itself: no public weights. Don't reach for audio-domain generative models (MusicGen, Magenta RT) for the *notes* — token rates and context requirements make tight sync much harder in two days.

## How much to fine-tune

Honest framing: **fine-tuning is the highest-risk, lowest-return item on your 48-hour clock.** It's also the thing a jury least perceives. Make it a parallel track with a hard abandon-time, never on the critical path.

If you do it:
- Full fine-tune of the 128M model, not LoRA. At that size LoRA buys you nothing and adds plumbing.
- **Fine-tune for identity, not for loss.** Pick one narrow idiom with a few hundred to a few thousand MIDI files — Alpine/folk, jazz comping, Baroque two-part counterpoint, gamelan — and give the duet partner a recognizable character. "Our AI plays in the style of X" is a pitch; "our val loss dropped 0.3" is not.
- LR 1e-5 to 5e-5, 1–3 epochs, keep the base checkpoint loadable at runtime with a flag. Overfit-to-mush is the failure mode, and you want A/B switchable in the demo.
- Rent an A100/L4 for 2–3 hours (Modal, Lightning, Colab Pro). Don't fine-tune on the Mac.

**Cheaper wins that read as "smarter model" to a jury**, per hour spent:
- **Best-of-k reranking.** Generate 4–8 candidate continuations, score each with a cheap heuristic (harmonic fit against the last few human notes, voice-leading distance, density match), play the winner. This is a poor man's ReaLchords reward model and takes maybe two hours. Biggest quality-per-hour item on the list.
- **Logit masking** for key/scale constraints and density control.
- **Temperature and instrument conditioning** exposed as live knobs.

## Sound: where LYDIA/Morpho earns its place

Project LYDIA is Roland Future Design Lab's prototype with Neutone, running Morpho's neural sampling on a Raspberry Pi 5 — it learns the tonal qualities of one sound and applies them to another in real time. It is timbre transfer, not note generation, so it doesn't compete with your transformer; it stacks on top. Render your model's MIDI through a synth, then morph it. The judges hear an AI partner whose *voice* is an alpine stream or the player's own instrument. That's a two-layer AI story with a sponsor tool in it.

## Splitting four people

1. **Clock and scheduler.** The transport, MIDI I/O, lookahead/commit buffer, note cancellation and rescheduling. Highest risk, most demo-critical.
2. **Inference service.** Model loading, KV caching, batched candidate generation, warm start, and a benchmark harness. Owns the "can we hit the deadline" number.
3. **Data, fine-tune, reranker.** Ships the reranker first, fine-tune second.
4. **Interface, sound, and pitch.** Waterfall display of upcoming notes, Morpho chain, and the three-minute story.

Rough shape of the two days:

- **First 2 hours.** One person gets AMT to generate a MIDI continuation from a file and measures tokens/second on your actual hardware. This is a go/no-go: compute how many beats of accompaniment you can produce per second at 100 BPM. Everything else waits on that number.
- **Hours 2–8.** Build the full real-time loop against a **stub accompanist** — a hardcoded I-V-vi-IV or a random-notes-in-key generator with an artificial 400 ms sleep. If the loop is musical with a stub, swapping in the transformer is a config change. This is the single most important structural decision you'll make; teams that build model-first almost always demo a broken clock.
- **Hours 8–20.** Swap the real model in. Tune lookahead/commit by playing. Start the fine-tune in the background.
- **Hours 20–36.** Reranker, Morpho chain, waterfall UI.
- **Last 8 hours.** Freeze. Rehearse the demo ten times. Record a video backup.

## Three things that kill this demo

- **Audio input instead of MIDI.** Pitch tracking on a live instrument adds latency, octave errors, and onset jitter. Use a MIDI keyboard as primary. If you want a singer or a violin, make it a second input path behind a flag.
- **No fixed tempo.** Beat tracking a free-tempo human is a research project. Run a metronome/click, at least for v1. Some players find it constraining, so make it toggleable, but don't build v1 without it.
- **Nobody owns the performance.** Decide on day one who plays in the final demo and what they play. A 90-second prepared phrase that shows the model adapting to a key change beats three minutes of aimless noodling.

One small pitch idea, since you're in the Hohe Tauern: record alpine sounds with the handheld recorders on day one, train a Morpho model on them, and let the AI duet partner's timbre *be* the landscape. That quietly gestures at Challenge 1 while staying squarely inside Challenge 2.