# duet.ai architecture review: synthesis

Date: 2026-09-13. Inputs: `2026-09-13-review-browser.md` and `2026-09-13-review-service.md` (two independent reviewers, every claim with a file and line), the benches under `bench/` and `services/amt/`, and verification of the findings that change decisions. This document is the ranked view; the two reviews hold the detail.

## Verdict in one paragraph

The shape is right and matches the published live systems: audio to notes in the browser, a symbolic model on a GPU, a zero-latency pattern engine as the floor. The pitch and note stages are at parity with pYIN on real amateur singers and are the only calibrated stages; stop optimising them. Everything downstream of the notes is where the value is lost: harmony arrives one to three seconds late and does not beat a static tonic chord on real singers, the model's anticipation capability is never used, tempo from a solo voice is syllable rate, and the same decisions are made in two or three places at once. The code carries the history of a three-day sprint: `main.ts` at 957 lines, seven copies of pitch-class math, about a dozen dead exports, tests that pin things nobody wants, and a bench number that was inflated by a bug.

## What the reviews found that I verified

1. **Keys under a singer were nearly silent.** The mic-source ceiling of MIDI 60 clamped only the top of an octave-4 comping window, leaving 58..60. Confirmed in `src/patterns/toolkit.ts` and fixed the same hour: the window now slides down with the ceiling. Honest re-measurement: keys clashing half bars 48 / 35 / 41 / 59% on the four real-voice songs (reported before as 15 / 19 / 6 / 28%; before any fix 65 to 94%). Gate ceilings re-baselined to the honest values. Lesson: a threshold measured while a feature is silently off is not a threshold.
2. **The service no longer guarantees a non-empty window.** A concurrent session on this account rewrote plan building around an `Arranger` (commit e3b581a) with the explicit policy that silence from a successful model call is a rest, and dropped the early-entry plan, the empty-window fill and the polyphonic keys voicing from the live path. The functions and their tests remain, uncalled. This reverses the fix made after the "AMT drops out" report. It is a design choice, not a bug, and it needs one owner: see Decisions.
3. **The model's anticipation is unused.** Every prompt is plain continuation; the predicted chord reaches the notes only as a pitch snap in the arrangement filter. Chord-tone share on the arpeggio clip is 0.39, chance level.
4. **Chord following does not beat a static tonic on real singers.** Sung-pitch-in-chord 34 to 40% following versus 38 to 50% static, oracle ceiling 48 to 59%. The synthetic chord is right 63% of the time when decided and 13% when applied at the bar start. The defect is latency, not the detector: 119 ms note, up to two beats of chord tick, up to a bar of next-bar scheduling.
5. **Timing has no margin above 110 bpm.** The generation deadline is a fixed fraction of the window and ignores the ~170 ms relay hop; late notes are dropped silently on the client. The half-bar cue is a `setTimeout`, clamped to one second in a background tab. Tempo changes reconnect the socket, re-enter the eight-beat listen gate, and hit the relay's six-per-minute upgrade cap.
6. **Health is not readiness.** `/health` returns 200 while the model is still loading, the model loads on the first WebSocket under the global lock, and the relay reports `amt: true` on any 200. The watchdog cannot tell a hung pod from a healthy one.
7. **Two or three of everything.** Two chord brains (browser harmonizer and service brain), two song forms in lockstep plus a third under AMT, a two-bar freshness arbiter that silently swaps the harmony source, and a private degraded bandleader for AMT drums with a fixed seed and no humanize.
8. **The harmony brain is patches on patches.** Harmonizer plus predictor plus blend plus a rejection memory plus a 125 ms tick offset, about twelve constants tuned on four synthetic clips. One forward-filtered HMM with the harmonizer coverage as emissions replaces all of it. The learned transition table is fitted on a CC BY-NC corpus; fine for the hackathon, not for a paid product.

## Decisions for the owner

- **Empty window: rest or fill?** The dropout report said fill; the architecture-contracts session says rest. Recommendation: fill with the key-only plan only when the model has heard fewer than eight beats or returned nothing for two consecutive windows; treat a single empty window as a rest. Both behaviours stay testable.
- **Tap or count-in by default under a mic.** The data says a solo voice's first five seconds contain no beat. Defaulting mic-only sessions to the count-in, with the syllable tempo shown as a hint, is a UX decision.
- **Chordonomicon licence.** Keep the hand table as default (already done) and either delete the fitted matrices or refit on permissive data before any paid tier.

## Ranked plan

Effort is hours; "demo" means safe before the demo with an easy revert.

| # | change | gain | effort | demo |
|---|---|---|---|---|
| 1 | Log truncation off on the pod, `tooLate` and queue latency surfaced in the client status line, then read one real set | discard rate and latency budget become facts | 1 | yes |
| 2 | Tempo-aware deadline (`window - measured RTT - 150 ms`), half-bar cue from the Transport not `setTimeout` | no silent late-note drops at 110 bpm and above, no background-tab second | 2 | yes |
| 3 | `/health` 503 until the model is loaded; load at process start | watchdog and deploy can tell broken from slow | 1 | yes |
| 4 | Build `liveActions` once, `pendingBpm` on onset not per emit, level emits throttled to 10 Hz | removes a 200-line allocation and an IOI histogram at 50 Hz from the thread that runs the pitch poll | 2 | yes |
| 5 | One `SongForm`; one pitch-class module; delete the dead exports listed in the browser review; AMT drums through a real Bandleader | about 250 lines removed, one fewer lockstep, AMT drums get fills and humanize | 5 | yes |
| 6 | Client reconnect with backoff, `set {bpm}` instead of reconnect on tempo change, relay cap raised | a blip costs two bars, not the set | 6 | cap yes, rest after |
| 7 | Downbeat phase from onset folding; count-in default under mic (decision above) | bar one lands on a beat | 3 | phase yes |
| 8 | Engine-owned harmony: delete `planOverride`, pause the browser chord tick while AMT owns harmony | no silent brain swap | 3 | no |
| 9 | One forward-filtered HMM for harmony, both transition tables as data | twelve constants become four, one code path | 8 | no |
| 10 | Predicted chord as anticipated control events to the model, pitch snap becomes a soft penalty | harmony stops being a post-filter; measured by chord-tone share (0.39 today) | 8 + bench | no |
| 11 | Pitch in the worklet, FFT autocorrelation | no main-thread jitter on the pitch hop, ten times less CPU | 5 | no |
| 12 | Calibrate the unmeasured constants: onset, chord, form, humanize; singer tuning-offset experiment for key | guessed constants become measured | 4 | bench only |

Items 1 to 5 are one working day, touch nothing the model plays, and remove the two masked hazards (silent late notes, silent keys). Items 9 and 10 are the only changes that would make the accompaniment measurably better rather than merely reliable.

## What to stop doing

- Tuning pitch estimation: it is at the ceiling of the data.
- Adding a rule to the harmony brain: each one so far moved one bench scenario and cost another.
- Measuring against synthetic voices alone: every real-voice finding contradicted a synthetic one.
- Treating a passing gate as proof: a gate is only as honest as the state it was baselined in.
