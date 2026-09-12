# Browser-side review: listener, band, patterns, engines

Date: 2026-09-13. Scope: `src/listener/**`, `src/band/**`, `src/patterns/**`, `src/music/**`,
`src/engines/{amtEngine,patternEngine,fallback}.ts`, `src/main.ts`, `bench/**`. Read-only review;
no code changed. Numbers come from `wc -l`, `grep`, `git log` on this worktree at `025a2f0` and from
the committed `RESULTS.md` / `CALIBRATION.md` files.

Size of what was reviewed (lines, source only unless stated):

| file | lines | commits since 2026-09-11 |
|---|---|---|
| src/main.ts | 957 | 69 |
| src/engines/amtEngine.ts | 590 (+774 test) | 24 |
| src/listener/listener.ts | 294 (+392 test) | 24 |
| src/listener/chordDetector.ts | 290 (+246 test) | 5 |
| src/listener/micSource.ts | 236 | |
| src/patterns/variation.ts | 230 (+231 test) | |
| src/listener/activity.ts | 198 | |
| src/listener/onset.ts | 179 | |
| src/band/bandleader.ts | 160 (+254 test) | |
| src/listener/pitchTracker.ts | 130 | |
| src/listener/keyDetector.ts | 130 | |
| src/music/voiceLeading.ts | 121 | |
| src/listener/tempoLock.ts | 111 | |
| src/types.ts | 97 | 12 |
| src/patterns/toolkit.ts | 129 | |
| four genre files | 40-43 each | |
| tests under src/ | 6668 total | |

The whole repository is three days old (first commit 2026-09-11, 314 commits). Most of what follows
is the normal debt of that pace, not negligence.

## 1. The algorithms, stage by stage

### 1.1 Pitch estimation: `src/listener/pitch.ts`

What it computes: one f0 estimate per 50 ms from a 4096-sample window (85 ms at 48 kHz).

Model: McLeod pitch method. Normalised square difference function (`pitch.ts:27-34`), computed by
direct time-domain autocorrelation over lags `sr/1200 .. sr/60` (40..800 lags at 48 kHz), parabolic
peak interpolation, first peak at or above 0.8 of the tallest peak after the first negative zero
crossing (`pitch.ts:43-61`). Clarity is the chosen peak's NSDF value. Gate: tallest peak below
`DEFAULT_TUNING.pitch.minClarity = 0.6` is rejected; energy below 1e-6 mean square is rejected.

Cost: N x L = 4096 x 760 = 3.1 M multiply-adds per frame; measured 3.94 ms per 50 ms frame
(`bench/pitchmodels/RESULTS.md`, mcleod section). The reference MPM uses an FFT autocorrelation,
O(N log N), which would be roughly 10x cheaper. Not a problem on a laptop; relevant on a phone where
this competes with the main thread (see 1.2 and 4).

Assumptions and where they fail for a singer: the pitch is stationary over 85 ms. A slide between
notes at a typical 4-6 semitones per 200 ms moves 1.7-2.5 semitones inside one window; the NSDF
peak smears and the estimate lands between notes. That is the "other err" column: 6.3 % mean,
28.6 % on abjones_3_02 (`bench/realvoice/RESULTS.md`). Octave errors are 0.1 %, so the 0.8
relative-peak rule is doing its job.

Measured: 92.4 % of voiced frames within 50 cents of the MIR-1K label (24 clips), female 94.6 %,
male 90.2 %. Synthetic: 97-100 % sustained, 88-93 % scales with 40-cent vibrato, 39-41 % with
100-cent vibrato (`bench/voice/RESULTS.md`).

SOTA counterpart and ceiling: pYIN on the same 24 clips scored 93.5 % (`pitchmodels/RESULTS.md`),
basicpitch 85.2 %, CREPE was not run. The hand labels are themselves a median 22 cents off the
nearest semitone and 41 % of frames are more than 30 cents off, so "within 50 cents of the label" is
near its ceiling at 93-95 %. Pitch estimation is not the bottleneck anywhere in this system. Do not
spend time here.

Hand-set constants: 60 and 1200 Hz limits, 0.8 relative peak, 1e-6 energy floor (all `pitch.ts`);
`minClarity` 0.6 is in `tuning.ts` and was swept by `bench/calibrate` (0.5-0.7; default kept).

### 1.2 Note segmentation: `src/listener/pitchTracker.ts`, worker plumbing in `pitchWorker.ts`, `pitchWorkerClient.ts`, `micSource.ts`

What it computes: a "stable" MIDI note (plus cents) from the stream of raw estimates, or null.

Model: a 3-frame median filter with an agreement count (2 of 3 within 50 cents of the median) and a
per-frame clarity gate (0.7 for voice), plus three heuristic state machines layered on top:
dropout hold (up to 2 missing frames keep the note, `pitchTracker.ts:59-69`), a glide freeze
(two consecutive same-direction moves over 35 cents freeze the reading until a move under 20 cents or
a reversal, `pitchTracker.ts:100-115`), and a sticky `stableHz` that only moves when the window
agrees (`pitchTracker.ts:84-86`). There is no probabilistic note model (no HMM, no Viterbi). The
"octave correction" the 2026-09-12 research spec describes (`docs/superpowers/specs/2026-09-12-voice-listener-research.md` table) is no longer in the code; the test
`pitchTracker.test.ts:19` passes because the median absorbs a single octave frame.

Assumptions that fail for a singer: (a) 50 ms between frames is slow enough to see a glide as two
monotonic steps; fast ornaments and scoops shorter than 100 ms are read as separate notes. (b) A
note is a run of agreeing frames; the label's note is a run of 120 ms within 50 cents of a
semitone (`realvoice/metrics.ts`), and a singer holding a note 40-60 cents off lets the two round
differently. RESULTS.md says this is most of what remains of the gap. (c) Vibrato stays under
50 cents peak; at 100 cents synthetic vibrato F1 collapses to 0.54-0.58.

Measured: real voice note F1 0.68 (P 0.68, R 0.70), median latency 119 ms; synthetic melodies
0.86-0.98, 105-157 ms; 18 false notes on a 0-note spoken clip (`voice/RESULTS.md`).

SOTA: pYIN's note HMM with Tony-style post-processing (Mauch et al. 2015) reports note F1 around
0.8 on trained singers; on MIR-1K amateurs the realistic ceiling given the label rounding issue is
perhaps 0.75. The pyin_online run in `pitchmodels/RESULTS.md` reached F1 0.70 at 140 ms, so the
frame-wise model is not leaving much on the table; the latency floor (3 frames x 50 ms + 85 ms
window centre) is the thing to attack, not F1.

Calibration: this is the one stage the calibration bench actually exercises. Stage 1 swept
holdFrames 2/3/4, tracker clarity 0.55-0.8, minAgree 2/3, maxDropout 1/2/3, glide 25-50 cents,
pitch clarity 0.5-0.7 (55 coordinate-descent evaluations, `CALIBRATION.md`). Best held-out gain was
+0.02 F1 at +11 ms latency and one lost synthetic key; defaults kept. `settledCents` (20) is not in
the grid.

Plumbing cost: `MicSource` polls an `AnalyserNode` from a main-thread `setInterval` every 50 ms
(`micSource.ts:131-161`), copies 4096 floats (`pitchBuf.slice()`), and transfers them to a Worker.
The AudioWorklet that already owns the audio thread (`public/worklet/onset-processor.js`) does not
see pitch at all. Consequences: setInterval jitter on a busy main thread adds 0-50 ms to the 50 ms
hop; a backgrounded tab throttles setInterval to 1 Hz and pitch tracking stops while the worklet
keeps running; the `StablePitch.stable` field is always `true` when the value is non-null
(`pitchTracker.ts:194`) and is vestigial.

### 1.3 Onsets and tempo: `onset.ts`, `onset-processor.js`, `tempoLock.ts`, `tempoFollower.ts`, `tapTempo.ts`

Onset model: log-compressed spectral flux (`log1p(20 * mag)`) summed over 40-5000 Hz, 1024-point
Hann FFT, 512 hop (10.7 ms), adaptive threshold = 75th percentile of the last second x 2.5 + 0.12,
peak picking in a +-3 hop window, 80 ms minimum gap (`onset.ts:85-92, 115-135, 156-162`). This is
Bello/Dixon spectral flux with a Boeck-style adaptive threshold, a textbook design for plucked and
struck instruments. The worklet duplicates the FFT and flux in plain JS because a worklet cannot
import from the bundle (`fft.ts:5-10`); `onset.test.ts:152-154` asserts the constants match by
string-searching the worklet source.

Assumptions that fail for a singer: a voice's flux peaks are consonant bursts and vowel onsets,
that is syllables, not beats. A legato pitch change on one vowel produces almost no flux in the
40-5000 Hz band. No bench scores onset precision/recall against labels at all (MIR-1K has no onset
labels; the synthetic bench has note starts but `voice/metrics.ts` does not score onsets), so
mult/delta/quantile/FLUX_K are unmeasured. None of them is in `tuning.ts`; the calibration bench
cannot touch them.

Tempo model: inter-onset-interval histogram (`tempoLock.ts:16-72`). IOIs are octave-folded into
60-180 bpm, the mode is found with a +-5 % window, then refined as the mean period within +-12 %.
For voice onsets, if half the mode lies in 70-130 and the histogram holds at least 40 % of the
winner's count there, the half is taken. No phase estimation: `downbeat` is `onsets[0]`
(`tempoLock.ts:71`), the first onset the listener ever heard, so the bar grid is anchored to the
first syllable of the first phrase. `TempoFollower` reruns the same histogram over the last 8
onsets, folds to the nearest octave and clamps to +-8 % per call (`tempoFollower.ts:16-33`).

Measured: synthetic melodies lock at 7-10 s with -0.1 to -0.2 bpm error (`voice/RESULTS.md`). Real
voice: 17 of 24 clips lock, 2 within 8 % of the backing track, 4 at double or half; on 3 of the 4
stitched songs the lock is 1.5-1.9x the backing tempo (174 vs 117, 139 vs 84, 165 vs 87). The
half-tempo rule never fires on those songs because the 12-onset histogram has no second peak.

SOTA: beat tracking (Ellis 2007 dynamic programming over an onset strength envelope; madmom's
RNN+DBN) estimates tempo and phase jointly and is reliable on full mixes, poor on solo voice. For a
solo singer the honest ceiling is "a singer does not carry the beat in the first 5 s". The system
already has `TapTempo` (median IOI of 3+ taps, `tapTempo.ts:15-26`) and a count-in; for mic-only
use those are the right default, and the lock from syllables should be treated as a hint. The
downbeat-from-first-onset is the larger defect: even when the bpm is right, bar 1 starts wherever
the singer first opened their mouth.

Hand-set constants, none calibrated: MIN 60, MAX 180, MIN_ONSETS 12, VOICE_MIN 70, VOICE_MAX 130,
VOICE_HALF_SHARE 0.4, the 0.05 s IOI floor, 5 % and 12 % windows (`tempoLock.ts`); window 8 and
maxStep 0.08 (`tempoFollower.ts`); PENDING_MIN_ONSETS 6, PROVISIONAL_WAIT_SEC 8
(`listener.ts:29-31`); RESTART_GAP_SEC 2 (`tapTempo.ts`).

Duplicated computation: `bpmFromOnsets` runs on every onset in `TempoLock.push`
(`tempoLock.ts:87`), again for the provisional path (`listener.ts:132`), again for `pendingBpm` on
every `Listener.input` read (`listener.ts:255`), and `TempoFollower` a fourth time. `input` is read
on every `emit()`, and `emit()` fires on every level sample (~31 Hz from `micSource.ts:173`), every
pitch frame (20 Hz) and every onset, so the histogram is rebuilt 50+ times a second.

### 1.4 Key: `keyDetector.ts`

Model: Krumhansl-Kessler major/minor profiles (`MAJ`, `MIN` at `keyDetector.ts:4-5`), Pearson
correlation against a 12-bin pitch-class histogram, best of 24. Two acceptance rules: correlation
>= 0.7 from 5 distinct notes or >= 0.6 from 8; or, after 2 s of held pitch, a scale covering >= 85 %
of held time with a 0.08 correlation lead over the runner-up. Once accepted the key is held until
another is accepted (`keyDetector.ts:83-87`). Histogram weights are seconds held (`addSustain`)
for the mic and velocity for MIDI. `KeyDetector.key` is a getter that mutates `locked`; it is read
from `Listener.input`, so every emit can lock a key.

Assumptions that fail: the K-K profiles describe pitch-class frequency in tonal music performed in
tune. With a median 22 cents of detune and 41 % of frames over 30 cents off, rounding to the nearest
semitone puts a quarter of the weight in neighbouring bins. Splitting weight between the two
neighbours was measured and locked fewer (12 vs 21, RESULTS.md). Not measured: estimating the
singer's global tuning offset (median cents over the clip) and recentering before rounding. The
per-clip "off-key cents" column is 16-30 and fairly constant within a clip, which is what a global
offset looks like. That is a cheap experiment the bench can run offline.

Measured: 19-21 of 24 clips lock (RESULTS.md says 21 after the coverage rule; CALIBRATION.md's
default row says 14/16 + 5/8 = 19), median 2.2-3.7 s; "plausible" (scale covers >= 85 % of the
labels) 4; "correct" (best-covering scale) 1. Synthetic: 4 of 4 correct in 3.0-4.4 s. The label's
own best scale covers 85 % on only 5 of 24 clips, so the plausible ceiling on this data is 5.

Calibration: exercised (stage 2, 625 tunings over earlyConfidence, coverMin, coverMargin,
coverMinSustainSec). The "keys only" candidate locked 8/8 held-out at the cost of F1 -0.02 and was
rejected by the adoption rule. `earlyNotes`, `fullNotes` and `confidence` were not in the grid.

SOTA: Temperley's Bayesian key finder, or any HMM over key with a chroma emission, gains little on
monophonic 8 s clips; the gain here is in the input representation (tuning-offset correction), not
the classifier.

### 1.5 Chord and the melody harmonizer: `chordDetector.ts`

Two models share the class. Polyphonic mode: 84 binary templates (7 qualities x 12 roots), cosine
similarity minus 0.5 x off-chord share, bass notes at or below G3 weighted 1.5, notes fading
linearly over a 2-beat window; hysteresis MIN_CONFIDENCE 0.55, SWITCH_MARGIN 0.1, HOLD_FLOOR 0.4
(`chordDetector.ts:96-126, 191-203`). This is Fujishima-style chroma template matching with a
hand-built switching rule. Melody mode (selected by the listener when no MIDI note arrived within
two windows, `listener.ts:280`, or when fewer than 3 pitch classes carry >= 10 % of the energy):
argmax of coverage over the six diatonic triads with a 1.5-bar window, tonic and sung-root
tie-breaks, switch margin 0.15, minimum coverage 0.5, else hold (`chordDetector.ts:239-256`). There
is no transition model in the browser; the first-order Markov table the one-brain spec describes
lives (or will live) in the service.

Measured, synthetic (`bench/voice/OUTPUT.md`, arpeggio outlining Am F C G Am Dm Em Am): the chord
in force at the bar start matches the truth on 13 % of bars; per half bar 25 %; the chord decided
from the bar's own notes 63 %. So the decision is acceptable and the problem is when it is applied:
a chord is decided at the half-bar tick from notes already sung and then played for the next half
bar, one to two beats behind. Real voice: "sung pitch in band chord" 34-40 % following versus
38-50 % static tonic. Following loses to a static tonic on 3 of 4 songs. The oracle (best diatonic
triad per half bar, knowing the labels) reaches 48-59 %, so even a perfect half-bar harmonizer
leaves half the sung frames outside the chord. The only honest reading: on amateur singers the
chord path adds nothing audible, and the realvoice A/B mixes are described as sounding "almost the
same".

Assumptions that fail: a sung line implies a diatonic triad per half bar. Amateurs sing passing
tones, chromatic approaches and out-of-tune notes; the oracle ceiling says the assumption is only
half right. The cosine template assumes a chord's tones are present together; a single voice never
fills one, which is why melody mode exists.

Hand-set constants not in `tuning.ts` and never swept: BASS_MAX_MIDI 55, BASS_BOOST 1.5,
OFF_CHORD_PENALTY 0.5, MIN_CONFIDENCE 0.55, SWITCH_MARGIN 0.1, HOLD_FLOOR 0.4, `windowSec` 2 beats
(`listener.ts:278`), the 0.3 velocity floor and 0.8 mic weight (`listener.ts:139, 172`). The
`ChordTuning` slice (templateMinShare, melodyWindowMul, melodySwitchMargin, melodyMinCoverage) is
plumbed through `Listener`, `ChordDetector` and `harmonizeMelody`, but `bench/calibrate/run.ts` has
no chord grid (`GRID_TRACKER`, `GRID_KEY` only, lines 44-57) and `fit.ts` takes its chords from
the listener. The slice is infrastructure without a measurement.

SOTA: melody harmonization is a sequence problem (MySong, Simon et al. 2008: HMM with chord
transitions and melody-given-chord emissions; later work with LSTMs). The one-brain spec moves
exactly that to the service. The right browser-side move is therefore to stop improving this
detector and make the handover clean (see 2.2).

### 1.6 Form: `form.ts`

Model: a streak counter. Intro for 2 bars, lift after 4 bars of intensity > 0.7, breakdown after 4
bars < 0.3, ending after 16 silent beats or `playerStopped`, then `ended` until reset
(`form.ts:27-34, 67-95`). Measured only by the scripted run in `bench/patterns/RESULTS.md`
(sections change where the script says they should). The assumption that intensity maps to
section is reasonable for a guitarist and weak for a singer, whose verse/chorus contrast is in
register and phrase length more than onset density. No bench measures form against a labelled
song. Two identical instances run in lockstep (see 2.1).

### 1.7 Patterns and variation: `toolkit.ts`, `variation.ts`, four genres

Model: a stochastic step sequencer. Each step has a probability `p`; `fires()` draws
`rng() < p + (1-p) * min(1, creativity + 0.5 * intensity)` (`toolkit.ts:20-24`). Velocity scales
0.6-1.0 with intensity. Template choice is uniform over 3 templates with probability
`creativity`, else template 0 (`variation.ts:28-41`). Phrase fills are per-slot Bernoulli draws
with weight `creativity * (0.5 + 0.5 * intensity) * 1.6 on section ends`. Arrangement masks
(intro/breakdown/lift/ending) are pure filters over an already generated bar.

Measured: distinct bar signatures over 32 bars rise from 1-8 (creativity 0) to 17-31 (creativity 1)
(`patterns/RESULTS.md`); gate floor is 3 at creativity 0.5 and 1. "Fill-ish hits" at creativity 1
reach 50 per 32 bars for lofi drums, more than one per bar, which is a lot of fills for lofi. No
bench measures musical plausibility; the gate measures variety only.

One mechanism does not do what its comment says: `pickTemplate`'s "synthetic history"
(`variation.ts:32-40`) re-derives what *would* have been picked on bars n-1 and n-2 from
`seededUnit(bar*7+1)`, a hash unrelated to the `ctx.rng` stream that made the real picks. The
three-in-a-row check compares the current pick against a fictional history. Either keep one
integer of real state (in the same memo object `voicingMemo` already provides) or drop the check.

### 1.8 Voice leading: `voiceLeading.ts`

Model: enumerate all k-subsets of the chord-tone candidates in `[low, high]` (k = 3 for triads, 4
for sevenths) and pick the subset minimising the sum of absolute moves against the previous
voicing after sorting both (`voiceLeading.ts:55-86`). For equal counts, sorted matching is the
exact 1-D assignment, so this is correct and the brute force is fine (C(18,4) = 3060 worst case). A
greedy fallback exists for > 18 candidates. `usedPc` is threaded through `search` and never used
(`voiceLeading.ts:64, 76`); the comment about preferring distinct pitch classes describes code
that is not there.

Measured: harmony bench total movement 1-7 semitones per change, max single-voice leap 1-4, gate
<= 4 (`harmony/RESULTS.md`, `thresholds.json`). The unit test allows 7 (`voiceLeading.test.ts:78`)
while the gate allows 4; one of the two is wrong about intent.

A real defect, masked by the bench: under a mic source the bandleader sets `keysHigh = 60`
(`bandleader.ts:148`). `chordPattern` computes `low = 12 * (octave + 1) - 2` and
`high = min(low + 23, keysHigh)` (`toolkit.ts:73-78`). Lofi, jazz and funk keys use octave 4, so
low = 58 and high = 60: a three-semitone window holding at most one chord tone. `voiceLead` then
returns zero or one note per hit instead of three or four. Rock (octave 3) gets 46..60 and is
fine. `bench/realvoice/RESULTS.md` observed the symptom on leon_8 ("the only chord tone inside the
narrow octave-4 register below the 60 ceiling is a single pitch class") and attributed part of the
dissonance drop (65-94 % to 15-28 %) to smarter voicing; a good part of it is that the keys mostly
stopped playing. `bandleader.test.ts:142` checks that `keysHigh` is threaded, not that the comp
still has three voices; `genreContract.ts` never runs with `keysHigh` set. The fix is one line
(move `low` down with `high`), but `thresholds.json`'s `keysDissonantCeiling` values will then be
wrong and need re-measuring.

### 1.9 Chord colour: `chordColor.ts`

A lookup: genre x diatonic degree x detected quality to a seventh quality; mic source or rock or a
non-diatonic root pass through (`chordColor.ts:26-65`). Correct, 14 tests, 65 lines of if/else
that would be a 4 x 7 table. Measured indirectly in the harmony bench's "colored chord" column.

### 1.10 Humanize: `bandleader.ts:24-36`

Model: i.i.d. uniform timing jitter of +-8 ms (+-4 ms for kick and snare) and +-10 % velocity,
seeded. Human timing deviation is correlated (a drummer pushes or drags a whole bar, swing is a
systematic offset on off-beats), and 8 ms is at or below the timing JND for most listeners, so this
is mostly inaudible noise. It is applied only on the Pattern path: AMT's local drums
(`amtEngine.ts:226-232`) and every plan note skip it. No bench or listening test measures it; the
unit tests pin the constants (`humanize.test.ts:10, 24`). `Players.schedule` then merges notes
within 1 ms on mono voices (`players.ts:233-260`), so jitter can also create or remove collisions.

### 1.11 Engine arbitration and fallback: `fallback.ts`, `planOverride.ts`, `main.ts:303-421`

`chooseFallback` has three identical branches that all return `'patterns'` (`fallback.ts:13-15`);
it is `current !== 'patterns'`. `armFallback` (`main.ts:373-421`) is an 8 s watchdog on connect or
first block that swaps in a `PatternEngine` at the same bpm. `PlanFreshness` (`planOverride.ts`)
records the bar a plan chord/section last arrived on and calls it fresh for 2 bars; `chooseChord` /
`chooseSection` return the plan value only when engine is AMT and the plan is fresh. This means a
slow or silent service flips the band from the service's harmony to the browser's after two bars
and back again on the next plan, with no indication, while both brains keep running. The
"freshness" clock is `store.state.bar`, a UI store field (`main.ts:223, 349, 357, 512`).

### 1.12 The AMT client: `amtEngine.ts`

What it does: opens a WebSocket, sends `start`, then `set` (throttled to one per 250 ms and only on
change, `queueSet`/`flushSet` lines 323-370), batches performance events every 100 ms
(`flushNotes`), cues the server every half bar with `tick` (or `bar` for old servers), receives
`plan` frames, filters and de-duplicates notes by `voice:gmInstr:beat:pitch` (`noteKey`), schedules
anything at least 20 ms in the future via `Players`, keeps muted voices' notes pending, and runs
the local drum pattern itself on each bar. It also estimates response latency per capture with a
microtask-coalesced min over sampler confirmations (`queueResponseTiming`, lines 501-522).

Assessment: the scheduling core (lines 435-497) is sound and the dedupe-instead-of-commit-window
comment explains a real bug fix. Around it there is a second, degraded bandleader: the drum loop
at 226-232 builds its own `BarContext` with a fixed `mulberry32(42)` rng, no `chordAt`, no
`arrangement`, no `keysHigh`, no `humanize`, and the drums therefore ignore song form and fills
under AMT. Two input paths exist (`onPerformance` and `onNote`, lines 239-258); the real `Listener`
always has `onPerformance`, so the `onNote` branch only runs against test fakes. Three `*ForTest`
methods are public on the production class (lines 373, 393, 398). `setBpm` does a full
stop/start and reconnect (line 377-385), so follow mode with `bpmStep = 2` reconnects the socket on
every 2 bpm drift. 23 lines of latency-estimate coalescing exist to drive one readout.

Measured: the spec says ~240 ms cue-to-plan on the L40S and 62 % downbeat-landing at 2-beat
commits vs 50 % at 4 (`amtEngine.ts:17-18`, citing a HARMONY_BENCH.md that is not in this tree).
`changeLatencyMs = 2 beats` = 1.0-1.4 s at 85-120 bpm.

## 2. Overcomplication

### 2.1 Two SongForm instances in lockstep

`Bandleader.songForm` (`bandleader.ts:66, 137`) and `main.ts`'s `songForm` (`main.ts:108, 157`)
are driven with the same `dynamics` and rely on determinism to agree (`form.ts:49-53` documents this
as a feature). Under AMT there is a third in the service. Simpler: `Bandleader.onBarCb(bar,
form)` hands the section out, or `main.ts` owns the form and passes `arrangement` in `set()`.
Either removes one instance and the three `songForm.reset()` call sites in `main.ts` (lines 437, 531, 573).

### 2.2 Two chord brains plus an arbiter

Browser `ChordDetector` and the service harmony both run; `PlanFreshness` + `chooseChord` +
`chooseSection` (`planOverride.ts`, 50 lines, 11 tests) decide which wins per bar, and `main.ts`
has 23 references to `planChord`/`planSection`/`planFreshness` across eight sites (lines 109-114, 158-161, 219-223,
346-366, 405-407, 437-440, 512-513, 705-707). Simpler: the engine owns harmony while it is live.
`BandEngine` gets `ownsHarmony: boolean`; `Listener.tickChord` is not called while the live engine
owns it; fallback to Patterns flips the flag. One boolean, no freshness window, no silent brain
swap mid-song. The display reads whatever the band is actually playing from `band.state.chord`.

### 2.3 AMT's private drum bandleader

`amtEngine.ts:226-232` should be a `Bandleader` with only drums enabled, driven from the same
clock. That gives AMT drums humanize, arrangement, fills, `chordAt` and one rng seed, and deletes a
second `BarContext` construction.

### 2.4 Three "the input is a mic" flags

`BandState.source` (`types.ts:91`), `PerformanceEvent.source` (`performanceEvent.ts:5`),
`Listener.SourceKind` (`listener.ts:24`), and `micIsOnlySource()` recomputed every beat in
`main.ts:186-189` and pushed to the band through a type cast (`main.ts:152`) because
`BandEngine.set` does not accept it. `sungPitchClass` travels the same route. Simpler:
`BandInput` carries `melodic: boolean` and `sungPitchClass` once (the listener knows both), and
`BandEngine.set` accepts `Partial<BandState>`. Remove the cast.

### 2.5 Four timers for one grid

Beats 1-3 come from `setTimeout`s re-armed on every bar (`main.ts:329-331`); the half-bar chord tick
from another `setTimeout` (`main.ts:328`); `AmtEngine` has its own `halfBarTimer`
(`amtEngine.ts:219-225`); `ActivityTracker` re-estimates the beat length from tick spacing
(`activity.ts:137-140`) although the bpm is known. `ToneClock.scheduleRepeat('4n')` would give one
`onBeat(beat, time)` on the audio clock, and everything hangs off it.

### 2.6 Histogram on every emit

See 1.3. `pendingBpm` should be a field updated on onset, not a getter. `emit()` on every level
sample (31 Hz) also rebuilds `liveActions`, a 200-line object literal inside `store.subscribe`
(`main.ts:602-810`), and re-renders the LCD. Build `liveActions` once.

### 2.7 Pattern wrappers four deep

Each instrument is `withArrangement(withDrumPhrasing(chooseTemplate([...])))` and so on
(`lofi.ts:36-39`). Every layer is a closure returning `{ nextBar }`. A single
`buildBar(genre, inst, ctx)` that applies template pick, phrasing and arrangement as three plain
function calls would be flatter and easier to bench, and would not need `Pattern` objects at all
until the `Bandleader` boundary.

### 2.8 Response-timing estimator

`amtEngine.ts:500-522` plus `ScheduleConfirmation` plumbing through `Players.schedule` exists to
show one latency number. A `Players.onSchedule` hook already exists (`main.ts:866`); the estimate
can be one subtraction there.

### 2.9 Duplicated pitch-class and naming helpers

See 3.1. One `src/music/pitchClass.ts` with `mod12`, `NOTE_NAMES`, `pcDistance`, `centsBetween`,
`hzToMidi`, `keyName` replaces 7 copies in `src/` and 2 in `bench/`.

## 3. Duplication and dead code

### 3.1 Repeated helpers

| helper | copies | locations |
|---|---|---|
| `mod12` as a named const | 4 | `chordDetector.ts:41`, `toolkit.ts:9`, `voiceLeading.ts:10`, `chordColor.ts:4` |
| `((x % 12) + 12) % 12` inline | 4 | `keyDetector.ts:62, 73`, `main.ts:148`, `ui/live.ts:268` |
| `['C','C#',...,'B']` | 5 in src, 2 more in tests/bench | `scales.ts:8`, `chordDetector.ts:18`, `amtEngine.ts:15`, `acestepEngine.ts:9`, `ui/live.ts:12`; `chordDetector.test.ts:212`, `bench/harmony/run.ts:19` |
| key to string | 4 | `scales.ts:keyName` ("C maj"), `amtEngine.ts:34 keyString` ("C major"), `acestepEngine.ts:16 keyString` (identical), `ui/live.ts:206` inline |
| `BEATS_PER_BAR = 4` | 5 | `main.ts:68`, `bandleader.ts:9`, `amtEngine.ts:16`, `activity.ts:38`, `ui/viz.ts:19`; also literal 4 in `form.ts`, `variation.ts`, `countIn.ts` |
| Hann + radix-2 FFT + flux | 2 | `fft.ts` / `onset.ts:138-153` and `public/worklet/onset-processor.js:22-93` (forced by worklet isolation; pinned by `onset.test.ts:152-154`) |
| `69 + 12 * log2(hz/440)` | 2 | `pitch.ts:64`, `pitchTracker.ts:125` |
| level from rms (`min(1, rms*20)`) | 3 | `micSource.ts:173, 207`, `onset.ts:116` (the `OnsetDetector.level` copy is never read by the app) |
| phone UA regex | 1 definition, 2 regexes | `micConstraints.ts:15` (`isPhoneUA`) and `:19` (separate iOS regex for constraints); consistent, not duplicated beyond that |

### 3.2 Dead or test-only exports and fields

| symbol | location | status |
|---|---|---|
| `detectPitchHz` | `pitch.ts:14` | used only in `pitch.test.ts` |
| `hzToMidi` | `pitch.ts:64` | used only in tests; `pitchTracker.ts:125` reimplements it |
| `MIN_CLARITY` | `pitch.ts:4` | re-export of a tuning value, no other reader |
| `TEMPLATE_MIN_SHARE` | `chordDetector.ts:220` | no reader anywhere (0 src, 0 tests, 0 bench) |
| `withTuning` | `tuning.ts:80` | no reader anywhere |
| `rankKeys` export | `keyDetector.ts:22` | internal use only |
| `MANUAL_INTENSITY_DEFAULT` | `activity.ts:24` | no reader outside the file |
| `Listener.lastChordBeat` | `listener.ts:55` | written, never read ("diagnostic only") |
| `OnsetDetector.processFrame` | `onset.ts:105` | no reader |
| `OnsetDetector.level` / `inputLevel` | `onset.ts:76, 113, 164` | test-only; app computes level in `MicSource` |
| `INSTRUMENT_PROFILE` | `pitchTracker.ts:32` | default param and bench comparison only; the app never runs pitch on an instrument (`pitchWorker.ts:4` uses `VOICE_PROFILE`; MIDI needs none) |
| `StablePitch.stable` | `pitchTracker.ts:10, 194` | always `true` when non-null |
| `chooseFallback(_reason)` | `fallback.ts:11` | unused parameter, three identical branches |
| `usedPc` | `voiceLeading.ts:64, 76` | threaded, never consulted |
| `AmtEngine.onNote` input path | `amtEngine.ts:253-258` | only reachable with a fake `NoteSource` |
| `flushSetForTest`, `flushNotesForTest`, `pollScheduleForTest` | `amtEngine.ts:373, 393, 398` | test hooks on the production class |
| `Listener.noteCbs` vs `performanceCbs` | `listener.ts:36, 76` | two channels carrying the same notes; `main.ts:478, 495` subscribes to both |
| `BandInput.pitch` inline type | `types.ts:39` | redeclares `StablePitch` |
| `Source.onPerformance` optional | `listener.ts:17` | only `Listener` itself implements it; sources do not |

### 3.3 Tests that pin behaviour nobody asked for

- `creativity0.snapshot.test.ts` freezes the exact event list of every genre at creativity 0
  (including the 0.583 swung hat offsets in `lofi.ts:26`). Any musical improvement to a base
  pattern fails CI. A contract test (in key, in chord, non-empty, deterministic) already exists in
  `genreContract.ts`; the snapshot adds brittleness without a property.
- `humanize.test.ts:10, 24` pin +-4/8 ms and +-10 % as the tested property rather than "within
  bounds, deterministic, non-negative".
- `onset.test.ts:152-154` string-searches the worklet source for constant definitions. It protects
  the duplication instead of removing it (a build step could emit the worklet from `fft.ts`).
- `thresholds.json` `keysDissonantCeiling.leon_8 = 33` pins a known-bad state as acceptable, and
  the four ceilings were measured with the 58..60 register bug in place (1.8).
- `voiceLeading.test.ts:78` (leap <= 7) vs `thresholds.json` harmony (leap <= 4): the stricter one
  is the gate; the unit test is slack.
- `bandleader.test.ts:123-170`: five tests assert how `source` is threaded, none assert that the
  keys still voice a chord under `source: 'mic'`.

## 4. Runtime data flow, mic sample to scheduled note

Latencies are per hop, measured where a bench exists, else from the code's own constants.

```
 mic ADC ──getUserMedia──> MediaStreamSource ─┬─> AudioWorklet onset-processor.js   (audio thread)
   ~10 ms base latency                        │     512-hop FFT, flux, rms        +10.7 ms/hop
                                              │     postMessage {flux,rms,t}      ~1 ms
                                              │        │
                                              │        v
                                              │   OnsetDetector.pushFlux (main)   +32 ms (3-hop lookahead)
                                              │        │ onset time t (backdated)
                                              │        v
                                              │   Listener.onNote(-1, rms, t)     0 ms
                                              │     TempoLock.push  -> bpm after 12 onsets (4-10 s)
                                              │     ActivityTracker.onset
                                              │     onsetTimes ring (24) -> pendingBpm on every emit
                                              │
                                              └─> AnalyserNode fftSize 4096        (main thread)
                                                    setInterval 50 ms poll        +0..50 ms jitter
                                                    getFloatTimeDomainData, slice +85 ms window centre
                                                       │ transfer 16 KB
                                                       v
                                                  pitchWorker: detectPitch (McLeod) 3.9 ms
                                                               PitchTracker.push    +100 ms (2 of 3 frames)
                                                       │ {midi, cents}  measured median 119 ms total
                                                       v
                                                  Listener.onPitch
                                                    KeyDetector.addSustain/addNote -> key after 2-4 s
                                                    ChordDetector.addNote(midi, t, 0.8)
                                                    emitPerformance(note_on/off) ──────────────┐
                                                    emit() -> BandInput -> store.update -> LCD │
                                                                                               │
 clock ToneClock.onBar(bar, t)  (Tone transport, audio clock)                                  │
   │ main.ts wireBand.onBar                                                                    │
   ├─ tickBeat(beat): listener.tickBeat -> Dynamics; effectiveDynamics; band.set({dynamics,    │
   │                   source, sungPitchClass}); songForm.tick (main copy)                     │
   ├─ tickChord(beat): listener.tickChord -> ChordDetector.tick (melody/auto)                  │
   │                   -> band.set({chord, chordBeat}) unless planFreshness says AMT owns it    │
   │        decision latency: notes from the last 2 beats, applied from now  = 0.5-1.0 bar     │
   ├─ setTimeout x3 beats, x1 half-bar chord tick (wall clock, re-armed per bar)               │
   │                                                                                           │
   ├─ PatternEngine path: Bandleader.onBar(bar, t)                                             │
   │     songForm.tick (bandleader copy) -> arrangement                                        │
   │     chordAtBeat(barBeat) from chordLog (colorChord applied at set())                      │
   │     PATTERNS[genre][inst].nextBar(ctx) x4  -> humanize -> Players.schedule(inst, ev, t)   │
   │        applied on the NEXT bar boundary: +0..1 bar                                        │
   │                                                                                           │
   └─ AmtEngine path:                                        <──── PerformanceEvents ──────────┘
         noteBuf, flush every 100 ms -> ws 'notes'            +0..100 ms
         cue 'tick' at bar and half bar -> ws                 server ~240 ms cue-to-plan
         <- 'plan' {notes[], chord, chordFrom, section}       commit horizon 2 beats ahead
         scheduleDue every 100 ms -> Players.schedule / scheduleAccompaniment (no humanize)
         local drums: PATTERNS[genre].drums.nextBar(own ctx) -> Players.schedule (no humanize)
         onChord/onSection -> main.ts planChord/planSection/planFreshness -> band.set({chord})

 Players.schedule -> Tone triggerAttackRelease at absolute audio time  (drops < now + 5 ms)
   -> output latency (outputLatencyMs, tens of ms on phones; subtracted in perfOffset at main.ts:475)
```

Where state is duplicated between browser and service under AMT: key (browser KeyDetector and
`set.key`), chord (browser ChordDetector, service harmony, `planChord`, `band.state.chord`),
section (main `songForm`, service form, `planSection`), dynamics (`intensity`, `space`,
`silenceBeats` sent in `set` and used locally), genre/creativity/amount/enabled (both), bpm and
bar origin (both, with the client reconnecting on every bpm change). The browser's chord and form
keep running under AMT solely to stay "warm" for fallback, which costs nothing in CPU but means two
answers exist for every musical question at all times.

End-to-end, mic to audible chord change on the Pattern path: 119 ms (note) + up to 2 beats (chord
tick) + up to 1 bar (next `onBar`) + output latency, so roughly 1.5-3 s at 90-120 bpm. That matches
the 13 % bar-start accuracy in `voice/OUTPUT.md` better than any detector flaw does.

## 5. Code quality

`main.ts` (957 lines, 69 commits in three days) holds 30 module-level `let`s and does boot, device
enumeration, morph bus, vocal monitor, engine construction and fallback, count-in, beat and
half-bar timers, a copy of song form, plan arbitration, recording, the demo visualiser and the
entire `LiveActions` table. The `LiveActions` object (lines 603-807) is rebuilt inside
`store.subscribe`, that is on every store update, which the listener drives at ~50 Hz. Natural
seams: `engineLifecycle.ts` (makeBand, wireBand, armFallback, setEngine), `transportTicks.ts`
(tickBeat, tickChord, timers), `audioGraph.ts` (morph, monitor, routing), `actions.ts` (the
LiveActions table, built once).

`types.ts` grows by accretion: `BarContext` has 9 fields, 5 optional, each added for one consumer
(`voicingMemo`, `keysHigh`, `sungPitchClass`, `arrangement`, `chordAt`); `BandState` gained
`source` and `sungPitchClass`, which are mic concerns inside the band's state; `BandInput.pitch`
redeclares `StablePitch`. `BandEngine.set` and `Bandleader.set` disagree on the accepted fields,
hence the cast at `main.ts:152`.

Module boundaries that leak: `patterns/toolkit.ts` and `patterns/variation.ts` import from
`listener/chordDetector.ts` (`chordDegreeToMidi`, `chordScale`, `tonicTriad`), so the pattern
layer depends on the analysis layer for music theory that belongs in `src/music/`.
`music/voiceLeading.ts` imports `QUALITY_TONES` from the listener for the same reason.
`band/planOverride.ts` imports `EngineChoice` from `ui/state.ts`; `engines/fallback.ts` too. The
band layer should not know the UI's engine enum.

Side-effecting getters: `KeyDetector.key` locks a key when read (`keyDetector.ts:83-87`);
`Listener.input` therefore has side effects and is read twice inside `tickChord`
(`listener.ts:277, 281`).

Tests: 6668 lines, more than the source they cover. `amtEngine.test.ts` (774 lines, 46 tests)
tests protocol mechanics thoroughly; `listener.test.ts` (28 tests) uses fake sources throughout;
nothing in `src/` tests mic-to-schedule end to end, which is the benches' job and they do it. The
tests are strong on "does the plumbing hold" and weak on "does the band play the right notes":
the 58..60 register defect passes every unit test and the contract. The calibration bench
covers the tracker and key detector and nothing else; onset, tempo, chord, form, humanize
constants are unmeasured and `thresholds.json` pins several of them at whatever they produced on
2026-09-12.

Naming: `Listener` is the analysis front end, not a listener. `tickBeat` and `tickChord` on
`Listener` are driven by `main.ts` timers, not by the listener. `PlayersLike` and `ClockLike` are
fine. `Bandleader.set(... source ...)` and `BandEngine.set` share a name with different contracts.
`StablePitch.stable` means "present". `chordAt` exists as a `BarContext` field, a toolkit function
and a `Bandleader` method (`chordAtBeat`).

## 6. Refactor plan, in priority order

| # | change | gain | effort | safe before demo |
|---|---|---|---|---|
| 1 | Fix the mic keys register: in `chordPattern` (`toolkit.ts:73-78`) set `low = high - 23` when `keysHigh` clamps, or clamp `keysHigh` to `low + 5` at least. Re-run `bench:realvoice`, re-measure `keysDissonantCeiling`. | keys comp returns to 3-4 voices under a singer instead of 0-1; removes a masked regression | 1 h + bench | Yes, but listen first: dissonance will rise from the masked 15-28 % and the ceilings in `thresholds.json` must be re-set honestly, not to whatever passes |
| 2 | Build `liveActions` once, outside `store.subscribe` (`main.ts:602-810`); make `pendingBpm` a field updated on onset (`listener.ts:255`); throttle `emit()` from `onLevel` to 10 Hz. | removes a 200-line allocation and an IOI histogram at ~50 Hz from the main thread, which is also where the 50 ms pitch poll runs; fewer missed pitch frames on phones | 2 h | Yes |
| 3 | One `SongForm`: delete `main.ts` copy, expose section from `Bandleader.onBarCb(bar, form)` or move form ownership to `main.ts` and pass `arrangement` through `set()`. | -40 lines, one fewer thing to keep in lockstep, three `reset()` sites collapse | 1-2 h | Yes |
| 4 | `src/music/pitchClass.ts`: `mod12`, `NOTE_NAMES`, `pcDistance`, `centsBetween`, `hzToMidi`, `keyName`; delete 7 copies; move `chordDegreeToMidi`/`chordScale`/`QUALITY_TONES`/`tonicTriad` from `listener/chordDetector.ts` into `src/music/chords.ts` so patterns stop importing the listener. | -30 lines, boundary fixed | 1 h | Yes |
| 5 | Delete dead code from 3.2 (`detectPitchHz`, `hzToMidi` dup, `TEMPLATE_MIN_SHARE`, `withTuning`, `lastChordBeat`, `processFrame`, `OnsetDetector.level`, `_reason`, `usedPc`, `StablePitch.stable`, AMT `onNote` path, the `*ForTest` hooks replaced by fake timers, `noteCbs` merged into `performanceCbs`). | -80 to -120 lines, three identical `chooseFallback` branches become one expression | 1-2 h | Yes |
| 6 | AMT drums through a `Bandleader` with only drums enabled instead of `amtEngine.ts:226-232`. | AMT drums get humanize, fills, arrangement, `chordAt`; one `BarContext` builder | 2 h | Yes |
| 7 | Replace `planOverride` with engine-owned harmony: `BandEngine.ownsHarmony`, `Listener.tickChord` paused while true, fallback flips it. Delete `PlanFreshness`, `chooseChord`, `chooseSection`, `planChord`, `planSection` and their 23 `main.ts` references. | -90 lines; removes a silent brain swap two bars after the service goes quiet; one answer per question | 3 h | No, after the demo: changes what happens when the service stalls |
| 8 | Downbeat phase: replace `downbeat: onsets[0]` (`tempoLock.ts:71`) with the phase that maximises onset alignment modulo the period (fold onsets into the bar, pick the densest phase), and under mic-only default to tap/count-in with syllable tempo shown as a hint. Add an onset-phase column to `bench/voice`. | bar 1 lands on a beat instead of on the first syllable; the one tempo defect the data says is fixable (bpm itself is 1.5-1.9x on 3 of 4 songs and the half rule cannot see it) | 3 h + bench column | Phase estimate yes; default-to-tap is a UX decision, ask |
| 9 | Pitch in the worklet: post 4096-sample frames (or run McLeod there) every 50 ms from `onset-processor.js`; delete the `AnalyserNode`, the `setInterval`, `pitchBuf.slice()` and the Worker round trip. Switch the NSDF to FFT autocorrelation while moving it. | removes 0-50 ms main-thread jitter from the pitch hop; survives tab throttling; ~10x less pitch CPU | 4-6 h | No |
| 10 | Extend `bench/calibrate` to the unmeasured constants: chord (`ChordTuning` is already plumbed), onset `mult/delta/quantile` (needs an onset-P/R metric on the synthetic clips), and a key-detector experiment that estimates and removes the singer's global tuning offset before rounding. Drop `creativity0.snapshot.test.ts` in favour of the contract. | turns four sets of guessed constants into measured ones; the tuning-offset experiment is the only untested idea with a plausible path to more than 5 plausible keys | 4 h | Bench only, yes |

Items 1-6 are about eight hours, remove roughly 250 lines, and fix one audible defect and one
performance hazard without changing any protocol. Items 7-9 change behaviour under failure or on
the audio thread and belong after the demo. Item 10 is what makes the next round of tuning
decisions evidence-based instead of RESULTS.md prose.

## Summary of findings, ranked

1. Under a mic source, lofi/jazz/funk keys voice into a 58..60 window and play 0-1 notes per hit
   (`toolkit.ts:73-78`, `bandleader.ts:148`). The realvoice dissonance gains and the thresholds
   built on them are partly this.
2. Chord following does not beat a static tonic on real singers (34-40 % vs 38-50 %) and the
   oracle ceiling is 48-59 %; the synthetic chord is right 63 % of the time when decided and 13 %
   of the time when applied. The problem is 1.5-3 s of pipeline latency, not the detector.
3. Tempo from a solo voice is syllable rate (1.5-1.9x on 3 of 4 songs) and the downbeat is the
   first onset ever heard. Phase is fixable; bpm needs tap/count-in by default for mic-only.
4. Pitch estimation (92.4 %, 0.1 % octave) and note segmentation (F1 0.68, 119 ms) are at parity
   with pYIN on the same data and are the only calibrated stages. Stop optimising them.
5. Two chord brains, two (three) song forms and a two-bar freshness arbiter run at once; a slow
   service silently swaps the band's harmony source.
6. Only tracker and key constants are calibrated; onset, tempo, chord, form and humanize
   constants have never been measured, and `ChordTuning` is plumbing with no bench behind it.
7. `main.ts` is 957 lines with 69 commits in three days, rebuilds a 200-line actions object and an
   IOI histogram on every ~50 Hz listener emit, and drives beats from wall-clock timers alongside
   the audio-clock transport.
8. Seven copies of `mod12`/note names, four key-to-string functions, five `BEATS_PER_BAR`, and
   about a dozen dead exports; patterns import music theory from the listener.
