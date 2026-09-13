# Musical identity in live AMT accompaniment

The user approved phrase memory, call-and-response, and section contrast. AMT remains the live engine. No new model, account, UI, or separate clock is needed.

A session-owned MusicalIdentity captures a bounded, completed 2–4-bar performer phrase in beats. It observes PerformanceHistory notes and held-note metadata before pruning, uses actual releases, ignores future data, and retains the selected hook across later context pruning. A single held note, invalid input, or dense simultaneous chord must not become a melody hook. New sessions reset it. Repeated cues cannot age or replay it twice.

When the performer has left a gap and no note is held, a remembered phrase can shape one enabled melodic instrument in a successful AMT response. Prefer a generated guitar/lead, otherwise keys; never overwrite bass as a melody. Preserve the phrase contour and relative rhythm, adapt its register and harmony in the existing arranger, and answer for at most two beats. No answer over active input, on every cue, after prolonged silence, at amount zero, or from completely empty AMT output. Creativity changes phrase transformation, not note count. Preserve explicit rests and give the performer time between answers.

Use the existing HarmonyBrain/SongForm as section authority. Intro and breakdown use fewer events and instruments, lift restores the available palette, ending thins and releases, ended stays silent. Section policies must never enable a disabled role or override amount, and must preserve model GM identity. Sparse phrases should remain audible rather than disappear accidentally. Sections change once per bar; recurring 8-bar contrast during steady playing prevents an endless unchanged groove. Do not force harmony changes or introduce a second competing form state.

All mutable identity state lives inside Session so LatestPlanner snapshots and freshness checks also cover it. Apply identity before arranger constraints and commit, so wire notes and model history agree. Keep protocol compatible. Verify deterministic phrase identity, bounded state, release/rest behavior, tempo scaling, section contrast, control limits, reset, and stale snapshot isolation. Listen to/render matched before-and-after examples; automated tests are not proof of musical taste.

## Review refinements

Only material control changes and new performance invalidate an in-flight answer; periodic silence/intensity telemetry must not starve it. Response melody uses a fixed sixteenth-note grid and amount-driven spacing regardless of creativity. The selected response instrument has priority in the section palette. Optional `phraseResponse` and `phraseInstrument` plan metadata lets the shared client cancel only the remembered answer when the performer resumes, including queued sampler audio, while ordinary accompaniment continues.

The phrase quotes its opening two beats without time compression. It needs at least two notes in that excerpt. Polyphonic calls and single long tones remain ordinary AMT accompaniment. This first version changes interval expansion and register rather than generating entirely new song forms or expressive guitar articulations.
