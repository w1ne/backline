# Musical identity validation

## Behavior

AMT now remembers a completed monophonic performer phrase spanning two to four bars and quotes its opening two beats during a later gap. It preserves beat rhythm, adapts contour/register through the existing harmonic arranger, and waits at least eight beats between answers. Held input, prolonged silence, intro/ending, empty AMT generation and disabled instruments do not trigger a remembered answer. Section density and instrumentation now use the existing form; steady playing cycles eight-bar groove, lift and breakdown sections, with sustained energy overriding the cycle.

## Reproducible GPU comparison

Run `python services/amt/bench_identity.py --out /tmp/identity.json` in the AMT environment. The probe runs the same human input and sampling seed with identity bypassed and enabled. Bypass is local to the probe; the production service is unchanged.

Verified on the RunPod CUDA small AMT model. Seed 0 returned no accompaniment for both calls and remained empty. Seed 1 provided the first nonempty paired samples:

| Human opening | Baseline pitches | Phrase answer pitches | Answer onset beats |
| --- | --- | --- | --- |
| C4, E4 (ascending) | C3 | C3, F3 | 12, 13 |
| C4, G3 (descending) | F3, A3 | A3, F3 | 12, 13 |

Both answers retained the performer's direction and stayed inside beats 12–14. Harmonic correction can change exact intervals. This is evidence of input-specific behavior, not proof of a listener preference or a model ranking. A local 32-second GM-soundfont audition renders call A baseline/new, then call B baseline/new; the rendering is not a recording of the Pi audio output.

## Verification record

Backend review approved state ownership, snapshot isolation, response freshness, section policy and commit ordering. Regression tests cover the final arranger, including fixed phrase rhythm across creativity levels, sparse output, instrument identity, mute controls, sustained notes, reset, duplicate/out-of-order cues, periodic telemetry and stale emission.

Final combined checkout: 726 frontend tests, 207 backend tests with 8 subtests, 40 Pi tests (one optional dependency skip), and 5 UNO Q tests passed. Web and Pi production builds passed. All 44 benchmark gates passed under the repository's current thresholds.

Native Chrome with the installed smplr Sampler confirmed the cancellation behavior: the ordinary stop handle alone left RMS 0.0246017, disconnecting the response output produced RMS 0, and independent backing retained RMS 0.0246017. See `src/players/phrasePlayback.browser.test.html` for the offline fixture. Engine tests also cover held input, sample-loading races, stale plans arriving after an onset/release, and preserving later backing on the same program.

Concurrent main changes were preserved, including transport half-bar cues, RTT-aware inference deadlines, model readiness and the pre-existing early/repeated-empty-window fallback. Phrase memory never manufactures a response from that fallback. The fallback is ordinary backing, so its behavior differs from the single-empty-window GPU comparison above.

A real Chrome session against the candidate RunPod service sent three eight-note MIDI calls through the shared UI: 20 plans received, three remembered responses, no application errors. Two late notes were dropped rather than scheduled off time. This checks the real protocol and sampler path; it does not establish zero latency or subjective musical quality.

Deployment compatibility: only clients advertising `phraseResponses: true` receive remembered answers. Older open clients retain ordinary AMT backing and section contrast until refreshed. The Pi was deliberately disconnected by the user during deployment and its final update is deferred until it reconnects and becomes idle. No live Pi files were replaced by this session.
