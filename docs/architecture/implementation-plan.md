# Performance-to-accompaniment architecture repair

User-approved scope: preserve real performance information, centralize arrangement,
make timing reliable, give controls consistent semantics, and make Pi updates recoverable.
AMT stays the primary RunPod model. Web/Pi retain the shared UI and local audio playback.

## Contracts and acceptance

1. Performance capture: lifecycle events carry stable IDs, source, MIDI pitch, velocity,
   confidence and capture time. MIDI releases and sustain must preserve held durations;
   monophonic mic transitions/silence must close held notes. AMT receives onset immediately
   and duration updates on release, without waiting for the release to begin reacting.
   Existing listener onset subscriptions remain compatible. Pitch estimation moves to a
   worker with bounded in-flight work; preserve all current pitch regression tests.
2. Arrangement: one server arranger owns final keys/bass/lead event construction, density,
   harmony constraints, and rests. Preserve model instrument identity. Respect enabled
   roles, zero amount, and intentional model rests. Distinguish explicit service failure
   fallback from normal rests. No second local melodic accompaniment competes with AMT.
   Creativity changes musical freedom; amount scales presence and density; enabled roles
   affect generation and playback consistently.
3. Timing: consume incoming notes/controls while generation runs; retain at most one newest
   pending cue per session. Discard obsolete plans after reset/cue supersession. Keep global
   model exclusion safe. Instrument capture-to-scheduled-output latency separately from
   inference latency, using explicit response correlation and the audio clock.
4. Pi updater: stage an immutable release, defer installation during active performance,
   serialize update attempts, retain the last known-good version, install and health-check
   before advancing COMMIT, and automatically roll back failed installs. Add deterministic
   shell integration coverage without touching a real device during tests.

## Work distribution

- Capture agent: source/listener lifecycle, AMT client performance transport, worker pitch.
- Arrangement agent: backend arrangement policy and controls, duration update ingestion.
- Pi agent: safe updater and tests.
- Parent: server latest-cue scheduling, timing integration, cross-component review,
  benchmarks, merges, and deployment verification.

Use isolated worktrees and focused commits. Reuse current tests and add behavioral
regressions for changed contracts. Review each result for spec compliance and code quality,
then run full frontend/server/update checks, the benchmark gate, both builds, and real
browser/cloud checks. Deploy only the integrated result; do not independently deploy agents.
