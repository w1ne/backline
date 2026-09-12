# Architecture repair validation

The implementation preserves MIDI/microphone note identity and releases, queues
pre-handshake releases, and sends observed held durations to AMT. MIDI sustain is
scoped to each port/channel and is cleared on disconnect. Pitch analysis runs in a
bounded worker queue with two automatic recovery attempts and a surfaced failure.
The tokenizer still encodes time, duration, instrument, and pitch; velocity,
confidence, and capture timestamps are preserved as metadata, not new model tokens.

The server receives continuously while a single GPU worker generates against an
isolated Session snapshot. Each connection retains one newest pending cue. A stale
candidate neither becomes committed history nor waits in a queue of obsolete plans.
The emission guard rechecks freshness after acquiring the socket send lock.

One arranger constrains actual model notes and owns role filtering, grid, and density.
It preserves GM identities and rests. It does not expand every note into a triad or
manufacture a root bass on every window. The browser retains local drums but no
second generated lead melody. Amount controls density on the server and gain once
in the browser; GM samplers now traverse the same role buses as local instruments.

Pi activity uses held input, observed onsets, recording, audible ambient beds, and a
30-second grace after performer activity. Always-on listening and perpetual local
drums do not alone declare an active performance. Updates defer on active/unknown
status, retain assets and systemd state, journal before mutation, validate renderer
health, and roll back failed or interrupted installations. See
[UPDATE.md](../../services/pi/UPDATE.md) for recovery limits.

Validation performed during integration:

- Production web and Pi builds; 681 frontend tests; 161 backend tests (plus two
  subtests); 40 Pi tests (one optional dependency skip); all 44 benchmark gates,
  including the MIR-1K real-voice subset.
- Browser fake microphone: quiet 220/440 Hz tones, +20-cent bend, and silence release;
  Worker loaded, both notes and bend tracked, no application error reported.
- Isolated L40S RunPod service: actual AMT plans for strings and guitar (GM24, lead),
  beat-window bounds, lifecycle capability, capture correlation, zero-amount silence.
- A burst of 31 cues produced only the newest pending cue (78); ping remained
  responsive during the burst. This is a functional overload probe, not a capacity
  or multi-tenant load benchmark.
- Pi updater tests cover failed install/health rollback, interrupted-process
  recovery, active/unknown-status deferral, download races, archive validation,
  stable-runner locking, and continuing automatic recovery scheduling.

Synthetic probes demonstrate execution and invariants, not subjective musical
quality on every performance. Response timing is an estimate from capture to
scheduled output including reported browser output delay, not a physical acoustic
round-trip measurement.

Live device follow-up found and repaired the missing remote preset action and the
Guitar role's missing model-instrument request. The role now requests GM24 directly,
without adding another UI. Update restoration preserves explicit preferences and
refuses a stale rolling release unless GitHub confirms it is ahead of the installed
commit. A real failed legacy-release installation rolled back to the working assets;
a simulated MIDI performance correctly caused the updater to defer. The Pi's output
monitor captured nonzero audio while AMT scheduling and response timing were active.

The final transport check exposed a native missing-edge exception during microphone
monitor teardown. The monitor is now disposed before the shared source disconnects,
with idempotent disposal. GM scheduler handles are cancelled on stop. Pi command
failures are acknowledged once and cannot prevent status publication; regression
tests cover subsequent commands and heartbeat after failure.

Concurrent main changes to the singer-aware keys range and its benchmark thresholds
were integrated without overwriting that work. The gate result uses the current
repository thresholds; it is not a claim of improved harmony against the previous
stricter dissonance thresholds.
