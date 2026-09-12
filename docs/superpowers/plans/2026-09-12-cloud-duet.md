# Cloud Duet Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development for bounded tasks. Parent owns integration, reviews and deployment.

**Goal:** Cohesive accompaniment with RunPod inference and usable web/Pi interfaces.
**Architecture:** Shared AMT cloud protocol; local immediate sampled monitor and rhythm section; visible model output status. Pi profile uses the public relay with explicitly allowed localhost origin.
**Tech Stack:** TypeScript, Tone, Vite, Python/FastAPI, PyTorch, RunPod, Cloudflare relay, Chromium/ALSA.

- [x] Benchmark model candidates on existing L4 without restarting live services. Compare small/medium AMT at 100 and 150 BPM with seeded C-major and changing-harmony phrases. Save timing, empty plans and note evidence to docs/cloud-model-review. Evaluate MRT2 against official runtime constraints and installed disk/GPU capacity.
- [x] Add regression cases in src/engines/amtEngine.test.ts: an empty plan does not invoke onFirstBlock; malformed or stale notes do not become ready; drums/lead work with AMT without duplicate cloud bass. Run targeted vitest, implement corrections, rerun.
- [x] Configure .env.pi and src/device/profile.ts for the same cloud relay, update relay allowed origins for installed renderer. Verify actual Pi-origin websocket. Keep explicit offline Patterns.
- [x] Improve src/ui/live.ts/styles.css: instrument/band hierarchy, meaningful startup/action, model descriptions and actual playback state; preserve tested control IDs. Extend services/pi/control.html, server.py and device/runtime.ts for sound/noise/drone and model state. Add meaningful control and state tests.
- [x] Run npm test, npm run build, npm run build:pi, Python Pi tests and relay tests/typecheck. Review all diffs for spec compliance and then quality.
- [x] Deploy Pi and run deterministic MIDI with captured audio and browser diagnostics; exercise public MIDI workflow. Merge/push verified changes, check public deployments, update deployment documentation with evidence and remaining limits.

Final Pi remote-controller browser check could not run after the Ethernet interface went DOWN; deployed hardware audio and main UI verification completed beforehand.
