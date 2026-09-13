# Real-voice bench results (MIR-1K amateur singers)

Generated 2026-09-13 by bench/realvoice/run.ts. 24 clips, 8 singers (6 clips female range, 2 male range), raw vocal channel, no processing, VOICE_PROFILE.

## Input: pitch, notes, key, tempo

| clip | range | s | off-key cents (median) | pitch acc % | octave err % | no pitch % | other err % | note F1 | P | R | notes (label/det) | latency ms | key lock s | key | key plausible | label key (cov) | tempo lock s | bpm | backing bpm |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| amy_4_01 | f | 8.0 | 19 | 96.2 | 0.0 | 0.0 | 3.8 | 0.81 | 0.79 | 0.85 | 13/14 | 109 | — | — | — | C min (78%) | — | — | 144 |
| Ani_1_01 | f | 8.8 | 21 | 86.5 | 0.0 | 5.2 | 8.3 | 0.67 | 0.56 | 0.83 | 12/18 | 127 | 3.36 | E maj | no | C# min (73%) | 8.55 | 93 | 71 |
| ariel_1_01 | f | 9.2 | 21 | 94.6 | 0.9 | 0.0 | 4.5 | 0.75 | 0.63 | 0.94 | 16/24 | 98 | 3.90 | G# min | no | F# min (78%) | — | — | 181 |
| heycat_2_01 | f | 12.0 | 24 | 98.6 | 0.0 | 0.0 | 1.4 | 0.63 | 0.63 | 0.63 | 24/24 | 96 | 3.46 | F min | no | C maj (69%) | 8.55 | 94 | 100 |
| titon_1_01 | f | 8.0 | 19 | 100.0 | 0.0 | 0.0 | 0.0 | 0.77 | 0.83 | 0.71 | 14/12 | 111 | 4.41 | D# maj | yes | A# maj (96%) | — | — | 68 |
| yifen_1_01 | f | 5.1 | 19 | 85.2 | 0.0 | 0.0 | 14.8 | 0.67 | 0.57 | 0.80 | 5/7 | 101 | 4.05 | D# maj | yes | C min (86%) | — | — | 165 |
| abjones_1_01 | m | 11.6 | 30 | 82.1 | 0.0 | 2.0 | 15.9 | 0.62 | 0.50 | 0.83 | 23/38 | 116 | 1.80 | B min | no | D# min (65%) | 9.06 | 89 | 68 |
| leon_1_01 | m | 7.2 | 26 | 94.7 | 0.0 | 0.0 | 5.3 | 0.80 | 0.67 | 1.00 | 16/24 | 110 | 2.60 | G# min | no | C min (68%) | — | — | 74 |

Means: pitch acc 92.2%, octave err 0.1%, no pitch 0.9%, note F1 0.71 (P 0.65, R 0.82), median latency 109 ms. Key locked on 7/8 clips (median 3.5 s), plausible on 2. Tempo locked on 3/8 clips; of those, 1 within 8% of the backing track's bpm, 0 at double or half of it. Median off-key distance of the labelled pitch from the nearest semitone: 21 cents; 40% of voiced frames are more than 30 cents from any semitone.

Female-range clips: pitch acc 93.5%, note F1 0.72. Male-range clips: pitch acc 88.4%, note F1 0.71.

## Fit: the band over four stitched ~30 s songs (lofi, creativity 0.5)

| song | s | detected bpm | backing bpm | key used | label key (cov) | sung pitch in band chord: following | static tonic | best diatonic triad per half bar | band notes in label key: following | static | dissonant half bars: following (bass / keys) | static (bass / keys) | chord changes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| amy_15 | 36.6 | 119 | 117 | D# min (label, no lock) | D# min (74%) | 45% | 45% | 47% | 100% | 100% | 78% (59% / 56%), 32 scored | 78% (59% / 56%) | 0 |
| yifen_1 | 33.8 | 81 | 84 | D# min | C min (72%) | 38% | 38% | 48% | 82% | 68% | 68% (26% / 63%), 19 scored | 68% (53% / 58%) | 5 |
| abjones_2 | 31.6 | 75 | 87 | A# maj | A# maj (76%) | 42% | 50% | 53% | 91% | 100% | 47% (29% / 47%), 17 scored | 47% (35% / 47%) | 5 |
| leon_8 | 35.8 | 97 | 148 | A min | E maj (70%) | 37% | 38% | 45% | 56% | 72% | 70% (48% / 59%), 27 scored | 74% (48% / 70%) | 4 |

Chord per bar, following band:

- amy_15: D#m7 D#m7 D#m7 D#m7 D#m7 D#m7 D#m7 D#m7 D#m7 D#m7 D#m7 D#m7 D#m7 D#m7 D#m7 D#m7 D#m7 D#m7 D#m7
- yifen_1: D#m7 D#m7 A#maj7 D#m7 D#m7 D#maj7 A#maj7 A#maj7 A#maj7 A#maj7 Bmaj7 Bmaj7
- abjones_2: A#maj7 A#maj7 A#maj7 D#maj7 C# A#maj7 A#maj7 A#maj7 A#maj7 A#maj7
- leon_8: Am7 Am7 Am7 Am7 Am7 Em7 Em7 Em7 Em7 Fmaj7 Gmaj7 Fmaj7 Fmaj7 Fmaj7

## Mixes

Not rendered on this run (fluidsynth / ffmpeg / GM soundfont missing).

## What the real voices showed

The pitch detector itself is not the problem. On 24 raw amateur recordings the McLeod estimate is within 50 cents of the hand label on 92% of voiced frames, with 0.1% octave errors and 1.2% frames returning nothing. That is better than the synthetic bench (87-90%), because real vibrato is narrower than the 50-cent synthetic one. The weakest clips belong to the pitchiest singer (abjones, median 30 cents off the nearest semitone): 67-82% accurate, with the misses being slides and scoops between notes, not octave jumps.

Note segmentation is worse than on synthetic voices: F1 0.67 against 0.86-0.98, with precision and recall both at 0.68 and a median latency of 117 ms. The first run of this bench scored F1 0.60 (precision 0.53, recall 0.72): the tracker emitted 1.4 notes for every note the labels imply. Half of the extra notes were the same note re-triggered right after a breath: the tracker reported its held reading as unstable during the one or two silent frames, the listener forgot the note, and when the voice came back the window still held two frames of the old note and reported it again before moving on. The tracker now vouches for a held note through a breath, a single unclear frame or a slide, and freezes its reading while the pitch is still moving monotonically by more than 35 cents a frame (the slide through the semitones between two notes). What is left of the gap is mostly long notes where the tracker and the hand label round a pitch 40-60 cents off to different semitones, which no segmentation rule can settle. Adding a 50 ms dwell before a new note is reported was benched and rejected: precision 0.70, recall 0.67, median latency 151 ms.

Key detection now happens, though the keys it finds are only as good as the singing. KeyDetector weighs a sung pitch by how long it is held and accepts a key early when one scale covers 85% of the held time and clearly beats the runner-up (coverage acceptance, keyDetector.ts); once accepted the key is held until another is accepted, and sung pitches are only snapped onto it while the singer is actually staying inside it. It locks on 21 of 24 clips (12 before), median 2.2 s, and the band gets a key on 2 of the 4 songs (1 before). Only 4 of the 21 name a key whose scale holds 85% of what was sung, but that is the ceiling of the data, not the detector: the best-fitting major or minor scale covers 85% of the labelled pitch classes on only 5 of 24 clips, because the median sung pitch is 22 cents off the nearest semitone and 41% of voiced frames are more than 30 cents off. Splitting each frame's weight between its two neighbouring semitones instead of rounding was measured and locks fewer (12 of 24). amy_15 and leon_8 still get no key in 36 s: their label scales cover 70-74% of what was sung, so neither rule can accept one, and lowering the correlation threshold to 0.45 was measured earlier to pick G# minor for leon_8 where the labels say E major.
Tempo from a solo voice: the syllable-rate histogram that used to lock here was 1.5-1.9x the backing track on three of the four songs (174 vs 117, 139 vs 84, 165 vs 87). The listener now locks a singer's tempo from the flux tempogram (src/listener/tempoFromVoice.ts) once its estimate is steady or 12 s after the first syllable; bench/tempo/RESULTS.md measures that on 110 stitched songs (62% within 8% of the backing track, 70% within 8% of it or an exact half/double, against 28% / 43% for the histogram). The per-clip rows still show the histogram's pending estimate because a clip is too short for the tempogram; use the song rows. The per-clip backing bpm is an autocorrelation estimate over 5-12 s and is itself octave-ambiguous.
Chord following does not separate from a static tonic on these singers. Sung pitch inside the band's chord is 36-45% following and 36-45% static; the best diatonic triad per half bar (an oracle that knows the labels) only reaches 48-59%, so even perfect half-bar harmonization would leave half of what was sung outside the chord. On the two songs with no key lock the band holds one chord for the whole song (0 changes), which is what a listener in the app would hear as the band not reacting at all.

The dissonance was in the keys, and the lofi colour caused it: with the chord/key coming from a keyboard-shaped `colorChord` and a comping register that ignored the singer, 65-94% of half bars had a keys note a minor second or tritone from a sung note sounding at the same time (bass alone was already 19-39%). Fixed: when the fit runs with `source: 'mic'` (this bench now does, since these are all mic-only singers), `colorChord` leaves every genre as a plain triad instead of maj7/min7/dom7, `chordPattern` (src/patterns/toolkit.ts) caps the keys register at ctx.keysHigh (60, below a typical sung range) instead of the octave-derived ceiling, and drops any keys note a semitone or tritone from ctx.sungPitchClass (the singer's pitch class, sampled every beat here) at that hit. Keys dissonance drops to 15/19/6/28% on the four songs -- three under the 25% target, leon_8 still over. leon_8 holds one fixed chord (no key lock, 0 changes) whose only chord tone inside the narrow octave-4 register below the 60 ceiling is a single pitch class; the per-hit filter avoids it at the sampled instant, but the note then sustains for up to two beats and a real singer's pitch keeps moving underneath it, so some overlap survives even with per-beat sampling. A genuine fix there needs either a wider comping register below the ceiling (tried: widening it to a full 23-semitone window below 60 gave the voicing more chord tones to choose from, but also more simultaneous voices and pushed dissonance up across all four songs, so it was reverted) or shorter keys note durations under a mic singer, neither applied here. "Sung pitch in band chord" is unchanged (still scored against the always-coloured chord, since that measures the harmonic function the band is thinking in, not the mic-aware voicing) -- not worse, as intended.

On the mixes: the voice is mixed 6 dB above the band as the app does, so the clashes are audible but not dominant; the amy_15 pair (following vs static tonic) is the direct A/B, and they sound almost the same, which is what the table says.

## What the columns mean

**Pitch acc %**: 50 ms analysis windows, on frames the MIR-1K label marks as voiced, where the raw McLeod estimate lands within 50 cents of the labelled pitch. **Octave err %**: the miss is an octave up or down. **No pitch %**: the detector returned nothing (below its RMS floor or no clear period). **Other err %**: everything else, mostly frames where the singer is sliding between notes, or the estimate landed on a fifth or a formant.

**Note F1 / P / R**: notes derived from the labels (a run of at least 120 ms within ±50 cents of one semitone) matched against the notes the PitchTracker emitted, same midi and within 400 ms of the labelled start, each used once. "notes (label/det)" is how many notes the labels imply versus how many the tracker emitted. **Latency ms**: median delay from labelled note start to the matched detection.

**Key lock s / key / key plausible**: when KeyDetector first reported a key, what it was, and whether that key's scale contains at least 85% of the labelled pitch classes weighted by duration. **Label key (cov)**: the major/minor scale that covers the most of the sung pitch classes, and how much it covers; a low value there means the singer is not in any one key (or is off by more than 50 cents a lot of the time), so no detector can be "right".

**Tempo lock s / bpm**: when the listener first reported a bpm, and what it was: for a clip the 12-onset histogram or the 8 s provisional path; for a song the voice tempogram (8.5-12 s). There is no ground-truth tempo in MIR-1K; the singers sang to a karaoke track that is not in the vocal channel, so the backing bpm is measured from that track (left channel).

**Fit table**: each song runs through the listener twice, once to find a tempo and key, once with chord ticks every half bar at that tempo; the lofi pattern bank is then driven bar by bar over the resulting chord timeline (coloured to maj7/min7 the way the bandleader does), with the listener's own dynamics. "Sung pitch in band chord" is the share of voiced label frames whose pitch class is a tone of the chord the band held in that half bar. "Band notes in label key" is the share of bass/keys/lead notes in the scale that best covers the labels. "Dissonant half bars" is the share of half bars (with both a sustained sung note and a bass or keys note) where some bass/keys note is a minor second or tritone against a sung note sounding at the same time. "Static tonic" is the same band told to hold the tonic chord of the same key for the whole song.