# Musical Identity Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. User has approved execution with subagents.

**Goal:** AMT develops a remembered performer phrase and audibly contrasts song sections.

**Architecture:** Session owns bounded beat-based phrase memory. Identity transforms one generated melodic voice before the sole Arranger constrains and commits it. Existing SongForm drives section contrast.

**Tech Stack:** Python AMT service, pytest, existing TypeScript browser/Pi playback.

- [ ] Implement `services/amt/musical_identity.py` and `test_musical_identity.py`: capture completed 2–4-bar phrases, bounded memory, hook selection, gap/held-note gating, cooldown, deterministic transformations, reset by new instance. Interface: `observe(notes, records, now_beat)` and `shape(notes, start_beat, end_beat, beat_seconds, now_beat, creativity, section)`. Notes in shape use model tuples `(onset_seconds,duration_seconds,program,pitch)`. Preserve no-input/no-model silence. Test rhythms/contours from contrasting human phrases, duration release, duplicate cues, muted/no melodic output, beat-to-seconds scaling, and finite bounds. Run `python3 -m pytest services/amt/test_musical_identity.py -q`.
- [ ] Integrate in `services/amt/server.py` before pruning and before constrain/commit. Feed all performance records. Add session tests proving transformed notes enter both commit history and wire, controls gate responses, and reset/fork preserve isolation.
- [ ] Extend `services/amt/form.py` and `arrangement.py` with section contrast. Use existing form only, steady-energy 8-bar contrast, same-bar idempotence, sparse intro/breakdown and full lift, ending release. Apply section after generation and before commit, preserving enabled roles and amount. Add tests with the same model notes across sections; verify outputs differ musically and stay bounded.
- [ ] Review spec compliance, then code quality with an independent subagent. Resolve findings and rerun relevant tests.
- [ ] Run all AMT tests plus web/Pi builds as applicable. Create reproducible matched musical examples and a short validation report. Merge main without overwriting concurrent work, deploy verified backend when idle, confirm health and real generation. Public/Pi need no rebuild for backend-only behavior unless integration changes require it.
