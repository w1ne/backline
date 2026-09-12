# One brain: harmony, form and timing owned by the AMT service

Date: 2026-09-12. Status: approved by the user ("make it proper"), implemented in three steps.

## Problem

Today two components decide what the band plays. The browser detects key and chord from the voice and runs song form; the AMT service hears the same notes, has its own harmonic opinion, and commits a bar ahead. Keys and bass come from the model, drums and lead from Patterns. The result: a band that half agrees with itself, answering what was sung about a bar ago.

## Target

One decision maker. The AMT service receives every sung note (it already does), decides the chord for the coming window, predicts the next chord so changes land on the downbeat, owns song form, and commits every half bar. The browser renders: it schedules the model's notes, runs Patterns for drums and lead against the chord the service sent, and shows the section. When the service is unreachable the browser's own detector and form take over unchanged, so the offline path stays what it is today.

## Steps

### 1. Half-bar commits
- Client: COMMIT_BEATS 4 -> 2, LOOKAHEAD_BEATS 4 stays, `bar` messages become `tick` messages every two beats (bar messages stay accepted by the server for old clients).
- Server: `plan_window` works in half bars; generation budget scales with the window; the empty-window fallback stays.
- Measure: the existing server log line, plus bench/streammuse tooling (latency per commit); target under 300 ms per half-bar commit on the L40S.

### 2. Harmony brain in the service
- Port the melody harmonizer (diatonic triads, coverage over 1.5 bars, hysteresis, tonic tie-break, sung-root tie-break) from src/listener/chordDetector.ts to services/amt/harmony.py with the same unit tests.
- Add next-chord prediction: given the key, the last four chords and the genre, a first-order transition table over diatonic degrees (I -> IV/V/vi, V -> I, ii -> V, vi -> IV/ii, and so on; minor-key equivalents) blended with the harmonizer's reading of the current half bar. The predicted chord is what the model's next window is voiced against and what the plan message carries.
- Plan message gains `chord` (name, as chordName produces) and `chordFrom` beat. Optional field, so an old client ignores it.
- Client: under AMT, `bandleader.set({ chord, chordBeat })` from the plan; the local detector still runs but only feeds the display and the offline path. A test proves a plan chord overrides the local one while AMT is live.
- Measured with bench/voice/output.ts style scoring in Python on the arpeggio progression: target chord-in-force-at-bar-start accuracy above 50% (today 13%).

### 3. Form in the service
- Port src/band/form.ts to services/amt/form.py with its tests; the service ticks it from silence and intensity the client already sends in `set` messages (add them if missing, optional fields).
- Plan message gains `section`. Client: under AMT, the section drives the status line and the Patterns arrangement mask; the local SongForm is used only when the engine is not AMT. Remove the duplicated SongForm in main.ts once the service carries it.
- Ending: the service sends `section: "ending"` then `"ended"`; the client stops the band exactly as it does today.

## Non-goals
Audio-domain generation, changing Lyria or ACE-Step, tempo sensing, any UI beyond the status line.

## Risks
- A regression in the service takes the live demo down: every step ships behind the existing fallback (Patterns keeps playing on any error) and is verified live through the relay before the next step starts.
- The pod must stay running; redeploy is `git pull` plus restarting the `amt` tmux session (services/DEPLOYED.md).
