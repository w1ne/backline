# Voice listener: signal processing audit and measurements

Date: 2026-09-12. Scope: what the mic path does to a singing or humming voice, how well, and whether the band's output relates to it. Everything below is measured with `npm run bench:voice` and `npm run bench:voice:output` on synthetic voices (harmonic series, two formants, 5.5 Hz vibrato, breath noise). Real recordings were not available in this pass; numbers will move with them.

## What the pipeline is

| stage | method | tuned for |
|---|---|---|
| pitch | McLeod pitch method (normalized autocorrelation, parabolic peak), 4096-sample window at 48 kHz (85 ms), polled every 50 ms | any monophonic source |
| note segmentation | PitchTracker: median of the last N frames, octave correction toward the held note, ±50 cent agreement, per-source clarity gate | instruments (N=5, clarity 0.85); voice profile N=3, clarity 0.7 |
| onsets | spectral flux in an AudioWorklet, 512-sample hops | plucked and struck instruments |
| tempo | histogram of inter-onset intervals folded into 60 to 180 bpm, 12 onsets to lock | anything with regular onsets |
| key | pitch-class histogram weighted by note velocity, Krumhansl-style profile match | ten or more notes |
| chord | 84 chord templates (7 qualities x 12 roots) scored by cosine similarity minus off-chord energy, re-decided every half bar | polyphonic keyboard |

## What was wrong for a voice, and what changed

1. **The raw clarity gate hid the voice profile.** `detectPitch` rejected every frame under NSDF 0.9, so the voice profile's 0.7 gate never saw a breathy frame. Now the raw gate is 0.6 and the tracker applies the per-source gate.
2. **One missing frame ended the note.** A breath, a consonant or one unclear frame reset the tracker, and the same note was emitted again 100 ms later. The tracker now holds a note through two missing frames.
3. **The chord detector could not read a single voice.** One pitch class scores 0.58 against every triad that contains it and two notes a fifth apart score 0.81 as a sus4, so the chord followed whichever root came first in the table, or nothing. The detector now has a melody mode, selected by the listener whenever no MIDI note arrived recently: it harmonizes the sung line with the diatonic triad that covers most of the pitch-class energy over the last bar and a half, with hysteresis and a tonic tie-break.
4. **Phones heard the band.** Echo cancellation was off everywhere; on a phone the band came back through the mic and the listener followed itself. Phones now get the browser echo canceller.

## Input measurements (voice profile, after the changes)

| clip | raw pitch acc | note F1 | median latency | key lock | tempo lock |
|---|---|---|---|---|---|
| sustained C3, A3, E4, A4 | 97 to 100% | 1.00 | 109 to 152 ms | | |
| C major scale, 40 cent vibrato, 60 ms portamento | 88% | 0.94 | 157 ms | 4.0 s | |
| C major scale, 100 cent vibrato | 41% | 0.41 | 204 ms | | |
| hummed melody, A2 root (low male) | 87% | 0.78 | 125 ms | 4.4 s, correct | 7.0 s, -0.1 bpm |
| hummed melody, A3 root | 87% | 0.88 | 125 ms | 5.7 s, correct | 7.6 s, -0.2 bpm |
| hummed melody, A4 root | 88% | 0.94 | 125 ms | 5.7 s, correct | 10.2 s, -0.2 bpm |
| arpeggiated progression, A3 | 90% | 0.89 | 136 ms | 3.7 s, correct | 7.6 s, -0.2 bpm |
| spoken-style pitch drift (truth: no notes) | | 28 false notes in 6 s | | | |

Before the changes the low melody scored F1 0.40 and the mid melody 0.79, with 189 ms latency.

Reading: a sung or hummed melody is followed note for note within about 125 ms once it is in tune to ±50 cents. Vibrato up to about 50 cents is fine; 100 cents (wide operatic vibrato) breaks the 85 ms window because the frame is a chirp, and only a longer analysis window or a learned pitch model fixes that. Speech leaks about five false notes a second, which is the price of the voice profile; the earlier instrument profile leaked two.

## Output measurements: does the harmony relate to the singing?

The band follows the singer through exactly two channels: the key, and the chord. Patterns voice every bar against the chord (tonic triad when there is none). The AMT engine sends the sung notes upstream as the melody and the chord as context.

On the scale-wise hummed melody there is no harmony to find and the tonic triad already covers 59% of sung notes; the harmonizer stays on the tonic, which is right.

On the arpeggiated line Am F C G Am Dm Em Am:

| measure | value |
|---|---|
| chord decided at the end of a bar matches that bar's chord | 63% (5 of 8) |
| chord in force at the start of a bar matches | 13% |
| chord in force per half bar matches | 25% |
| chord-tone coverage of sung notes, chord decided from the bar | 83% (tonic only: 61%) |
| before this work | no chord reading at all; tonic throughout |

Reading: the band now catches the chord a singer outlines, one half bar to one bar late. That lag is structural for a follower: the chord has to be sung before it can be known. The misses are the genuinely ambiguous windows (E and G alone read as E minor where C was meant).

## What the rest of the field does

- **Pitch tracking.** pYIN (Mauch and Dixon, 2014) is the standard classical method for singing: YIN with an HMM over candidates, and it handles vibrato and breath better than a single-frame estimator. CREPE (Kim et al., 2018) and its small variants are learned models that run in the browser via ONNX or TensorFlow.js at about 10 ms per frame. Spotify's Basic Pitch (2022) is a small CNN that transcribes voice to notes with onsets in the browser; it is the closest shipped equivalent of this listener's pitch plus segmentation stages.
- **Score and tempo following.** Antescofo (IRCAM) and Dannenberg's work follow a known score; that is not our case, since there is no score. Beat tracking from a voice alone is weak everywhere; products lean on a metronome or a count-in.
- **Accompaniment from a live melody.** Google's ReaLchords (2024) is the published system closest to this app: an RL-trained model that emits chords live for an incoming melody, one beat at a time, and its papers report the same one-beat lag trade-off measured here. Commercial tools (Smule, Yousician, SingStar) do pitch tracking against a known song, never open accompaniment.
- **Nobody hears audio and plays along end to end.** Every shipped system is symbolic in the middle: audio to notes, then notes to accompaniment. That is the architecture here too.

## Recommendations, in order

1. **Test with real voices now.** Record five to ten phone clips of teammates humming and singing, add them to `bench/voice/` as ground-truth clips, and rerun. The synthetic voice is a proxy.
2. **Count-in or tap tempo for singers.** The tempo lock needs 12 onsets and takes 7 to 10 s on a hummed melody. A two-bar count-in, or taking tempo from the first four tapped beats, would start the band sooner and more reliably than any onset detector on a voice.
3. **Chord one half bar earlier.** Decide the chord from the first two beats of a bar and apply it for the second half; the bench already shows the half-bar decision is right when the root and third have been sung.
4. **pYIN-style candidate smoothing** in the tracker (keep two or three pitch candidates per frame and pick the smoothest path) for wide vibrato and for the octave jumps of a low male voice. A learned model (CREPE tiny, Basic Pitch) is the step after, if the classical path tops out.
5. **Faster key lock.** Ten notes is 5 s of humming. Seed the key from the first three stable notes with a low-confidence flag, and let the band start on it.
