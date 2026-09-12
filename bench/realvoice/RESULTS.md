# Real-voice bench results (MIR-1K amateur singers)

Generated 2026-09-12 by bench/realvoice/run.ts. 24 clips, 12 singers (12 clips female range, 12 male range), raw vocal channel, no processing, VOICE_PROFILE.

## Input: pitch, notes, key, tempo

| clip | range | s | off-key cents (median) | pitch acc % | octave err % | no pitch % | other err % | note F1 | P | R | notes (label/det) | latency ms | key lock s | key | key plausible | label key (cov) | tempo lock s | bpm | backing bpm |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| amy_4_01 | f | 8.0 | 19 | 96.2 | 0.0 | 0.0 | 3.8 | 0.79 | 0.73 | 0.85 | 13/15 | 109 | — | — | — | C min (78%) | 6.45 | 103 | 144 |
| amy_15_03 | f | 6.9 | 21 | 97.9 | 0.0 | 0.0 | 2.1 | 0.58 | 0.48 | 0.73 | 15/23 | 113 | — | — | — | C min (70%) | — | — | 176 |
| Ani_1_01 | f | 8.8 | 21 | 86.5 | 0.0 | 5.2 | 8.3 | 0.46 | 0.35 | 0.67 | 12/23 | 127 | 3.05 | G# min | no | C# min (73%) | 5.41 | 97 | 71 |
| Ani_4_02 | f | 7.8 | 19 | 87.6 | 0.0 | 2.9 | 9.5 | 0.65 | 0.50 | 0.93 | 15/28 | 98 | — | — | — | B min (77%) | 5.11 | 138 | 117 |
| ariel_1_01 | f | 9.2 | 21 | 94.6 | 0.9 | 0.0 | 4.5 | 0.51 | 0.43 | 0.63 | 16/23 | 107 | 4.85 | C# maj | no | F# min (78%) | 4.50 | 109 | 181 |
| ariel_3_02 | f | 9.4 | 24 | 96.1 | 0.0 | 0.8 | 3.1 | 0.68 | 0.55 | 0.88 | 25/40 | 91 | 2.01 | G# maj | no | C min (87%) | 4.11 | 128 | 75 |
| heycat_2_01 | f | 12.0 | 24 | 98.6 | 0.0 | 0.0 | 1.4 | 0.53 | 0.44 | 0.67 | 24/36 | 115 | — | — | — | C maj (69%) | 6.15 | 88 | 100 |
| heycat_4_01 | f | 6.5 | 19 | 98.9 | 0.0 | 0.0 | 1.1 | 0.73 | 0.75 | 0.71 | 17/16 | 91 | 4.91 | — | — | G min (88%) | 4.46 | 122 | 134 |
| titon_1_01 | f | 8.0 | 19 | 100.0 | 0.0 | 0.0 | 0.0 | 0.60 | 0.56 | 0.64 | 14/16 | 111 | 4.70 | D# maj | yes | A# maj (96%) | 4.91 | 142 | 68 |
| titon_4_03 | f | 8.4 | 24 | 99.3 | 0.0 | 0.0 | 0.7 | 0.63 | 0.59 | 0.68 | 19/22 | 130 | — | — | — | E min (77%) | 6.01 | 139 | 134 |
| yifen_1_01 | f | 5.1 | 19 | 85.2 | 0.0 | 0.0 | 14.8 | 0.63 | 0.45 | 1.00 | 5/11 | 113 | 2.45 | C min | yes | C min (86%) | 4.26 | 139 | 165 |
| yifen_3_02 | f | 5.8 | 19 | 93.9 | 0.0 | 1.5 | 4.5 | 0.63 | 0.71 | 0.56 | 9/7 | 92 | — | — | — | D min (80%) | — | — | 89 |
| abjones_1_01 | m | 11.6 | 30 | 82.1 | 0.0 | 2.0 | 15.9 | 0.25 | 0.21 | 0.30 | 23/33 | 126 | 1.71 | F maj | no | D# min (65%) | 4.96 | 125 | 68 |
| abjones_3_02 | m | 7.2 | 30 | 67.0 | 0.0 | 4.4 | 28.6 | 0.50 | 0.35 | 0.90 | 10/26 | 167 | — | — | — | A# min (67%) | 4.85 | 129 | 64 |
| davidson_1_01 | m | 7.7 | 30 | 90.4 | 0.0 | 1.4 | 8.2 | 0.55 | 0.39 | 0.90 | 10/23 | 113 | — | — | — | C# maj (72%) | 4.65 | 165 | 181 |
| davidson_3_02 | m | 6.3 | 21 | 93.8 | 0.0 | 0.0 | 6.2 | 0.69 | 0.63 | 0.77 | 13/16 | 101 | 1.11 | F maj | no | D min (80%) | — | — | 72 |
| geniusturtle_4_01 | m | 7.2 | 23 | 95.7 | 0.0 | 1.7 | 2.6 | 0.71 | 0.65 | 0.79 | 14/17 | 86 | — | — | — | C# maj (85%) | — | — | 161 |
| geniusturtle_7_02 | m | 8.1 | 26 | 89.8 | 0.0 | 4.7 | 5.5 | 0.60 | 0.55 | 0.67 | 18/22 | 127 | — | — | — | B min (64%) | — | — | 152 |
| jmzen_1_01 | m | 9.2 | 23 | 90.7 | 0.9 | 0.0 | 8.3 | 0.50 | 0.39 | 0.69 | 13/23 | 137 | 2.10 | — | — | F min (79%) | 7.81 | 96 | 95 |
| jmzen_3_02 | m | 8.2 | 19 | 95.3 | 0.0 | 0.8 | 3.9 | 0.60 | 0.60 | 0.60 | 20/20 | 85 | 2.90 | E maj | no | A min (68%) | 6.71 | 144 | 131 |
| leon_1_01 | m | 7.2 | 26 | 94.7 | 0.0 | 0.0 | 5.3 | 0.70 | 0.58 | 0.88 | 16/24 | 109 | — | — | — | C min (68%) | 5.71 | 148 | 74 |
| leon_5_02 | m | 6.2 | 30 | 89.4 | 1.1 | 4.3 | 5.3 | 0.62 | 0.64 | 0.60 | 15/14 | 129 | 4.35 | C maj | no | F min (75%) | — | — | 78 |
| Kenshin_1_01 | m | 7.2 | 30 | 98.1 | 0.0 | 0.0 | 1.9 | 0.64 | 0.67 | 0.62 | 13/12 | 109 | — | — | — | E min (81%) | — | — | 170 |
| Kenshin_5_03 | m | 9.4 | 16 | 94.9 | 0.0 | 0.0 | 5.1 | 0.53 | 0.41 | 0.75 | 12/22 | 98 | 5.41 | A# min | no | F maj (84%) | 5.21 | 93 | 72 |

Means: pitch acc 92.4%, octave err 0.1%, no pitch 1.2%, note F1 0.60 (P 0.53, R 0.72), median latency 110 ms. Key locked on 12/24 clips (median 3.0 s), plausible on 2. Tempo locked on 17/24 clips; of those, 2 within 8% of the backing track's bpm, 4 at double or half of it. Median off-key distance of the labelled pitch from the nearest semitone: 22 cents; 41% of voiced frames are more than 30 cents from any semitone.

Female-range clips: pitch acc 94.6%, note F1 0.62. Male-range clips: pitch acc 90.2%, note F1 0.57.

## Fit: the band over four stitched ~30 s songs (lofi, creativity 0.5)

| song | s | detected bpm | backing bpm | key used | label key (cov) | sung pitch in band chord: following | static tonic | best diatonic triad per half bar | band notes in label key: following | static | dissonant half bars: following (bass / keys) | static (bass / keys) | chord changes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| amy_15 | 36.6 | 174 | 117 | D# min (label, no lock) | D# min (74%) | 45% | 45% | 48% | 100% | 100% | 52% (48% / 15%), 46 scored | 52% (48% / 15%) | 0 |
| yifen_1 | 33.8 | 139 | 84 | C min | C min (72%) | 43% | 41% | 53% | 100% | 100% | 32% (23% / 19%), 31 scored | 35% (26% / 26%) | 17 |
| abjones_2 | 31.6 | 165 | 87 | F maj | A# maj (76%) | 36% | 36% | 59% | 95% | 99% | 22% (16% / 6%), 32 scored | 19% (9% / 9%) | 17 |
| leon_8 | 35.8 | 144 | 148 | E maj (label, no lock) | E maj (70%) | 41% | 41% | 48% | 100% | 100% | 49% (38% / 28%), 39 scored | 49% (38% / 28%) | 0 |

Chord per bar, following band:

- amy_15: D#m7 D#m7 D#m7 D#m7 D#m7 D#m7 D#m7 D#m7 D#m7 D#m7 D#m7 D#m7 D#m7 D#m7 D#m7 D#m7 D#m7 D#m7 D#m7 D#m7 D#m7 D#m7 D#m7 D#m7 D#m7 D#m7 D#m7
- yifen_1: Cm7 Cm7 Fm7 A#maj7 D#maj7 A#maj7 Cm7 Cm7 Cm7 A#maj7 D#maj7 D#maj7 Gm7 Cm7 Cm7 D#maj7 A#maj7 Cm7 A#maj7
- abjones_2: Fmaj7 Fmaj7 Fmaj7 Fmaj7 Dm7 Cmaj7 Dm7 Cmaj7 Dm7 Fmaj7 A#maj7 Gm7 A#maj7 Fmaj7 Dm7 Am7 A#maj7 A#maj7 A#maj7 Fmaj7 A#maj7
- leon_8: Emaj7 Emaj7 Emaj7 Emaj7 Emaj7 Emaj7 Emaj7 Emaj7 Emaj7 Emaj7 Emaj7 Emaj7 Emaj7 Emaj7 Emaj7 Emaj7 Emaj7 Emaj7 Emaj7 Emaj7 Emaj7

## Mixes

- /home/andrii/projects/backline/.claude/worktrees/agent-ad70f004945d666e9/bench/realvoice/out/amy_15.mp3
- /home/andrii/projects/backline/.claude/worktrees/agent-ad70f004945d666e9/bench/realvoice/out/amy_15.static-tonic.mp3 (static-tonic baseline)
- /home/andrii/projects/backline/.claude/worktrees/agent-ad70f004945d666e9/bench/realvoice/out/yifen_1.mp3
- /home/andrii/projects/backline/.claude/worktrees/agent-ad70f004945d666e9/bench/realvoice/out/abjones_2.mp3
- /home/andrii/projects/backline/.claude/worktrees/agent-ad70f004945d666e9/bench/realvoice/out/leon_8.mp3

Raw voice at -3 dB over the fluidsynth-rendered band at -9 dB; not in git.

## What the real voices showed

The pitch detector itself is not the problem. On 24 raw amateur recordings the McLeod estimate is within 50 cents of the hand label on 92% of voiced frames, with 0.1% octave errors and 1.2% frames returning nothing. That is better than the synthetic bench (87-90%), because real vibrato is narrower than the 50-cent synthetic one. The weakest clips belong to the pitchiest singer (abjones, median 30 cents off the nearest semitone): 67-82% accurate, with the misses being slides and scoops between notes, not octave jumps.

Note segmentation is worse than on synthetic voices: F1 0.60 against 0.78-0.94, and the drop is almost all precision (0.53). The tracker emits about 1.4 notes for every note the labels imply; the extra ones are the intermediate semitones a real voice passes through while sliding or settling, which the synthetic portamento (60 ms) never produced. Recall (0.72) and latency (110 ms median, versus 125-157 ms synthetic) are fine.

Key detection mostly does not happen. It locked on 12 of 24 clips and on only 2 of the 4 thirty-second songs; of the 12 locks only 2 name a key whose scale holds 85% of what was sung. This is not the detector being slow: the labels themselves, fed straight into the same Krumhansl profiles, reach the 0.6 confidence KeyDetector requires on only 9 of 24 clips, and the best-fitting major or minor scale covers 85% of the sung pitch classes on only 5 of 24. The median sung pitch is 22 cents off the nearest semitone and 41% of voiced frames are more than 30 cents off, so when pitches are rounded to semitones a large share of the energy lands on chromatic neighbours of the intended notes, and the pitch-class histogram stops looking like any key. Splitting each frame's weight between its two neighbouring semitones instead of rounding makes it worse (3 of 24 reach 0.6). Lowering the threshold to 0.45 would lock all four songs within 2 s, but leon_8 would lock on G# minor where the labels say E major, so the threshold is not the lever; a coverage-based acceptance (most of the last two bars inside one scale, tonic weighted) is what needs benching.

Tempo from a solo voice is syllable rate, not beat rate. TempoLock reported a bpm on 17 of 24 clips, typically after 4-6 s, but on three of the four songs it is 1.5-1.9 times the backing track the singer was actually following (174 vs 117, 139 vs 84, 165 vs 87); only leon_8 (144 vs 148) matched. The per-clip backing bpm is an autocorrelation estimate over 5-12 s and is itself octave-ambiguous, so use the song rows for this. The synthetic bench could not show this because its notes sat exactly on the beat.

Chord following does not separate from a static tonic on these singers. Sung pitch inside the band's chord is 36-45% following and 36-45% static; the best diatonic triad per half bar (an oracle that knows the labels) only reaches 48-59%, so even perfect half-bar harmonization would leave half of what was sung outside the chord. On the two songs with no key lock the band holds one chord for the whole song (0 changes), which is what a listener in the app would hear as the band not reacting at all.

The dissonance was in the keys, and the lofi colour caused it: with the chord/key coming from a keyboard-shaped `colorChord` and a comping register that ignored the singer, 65-94% of half bars had a keys note a minor second or tritone from a sung note sounding at the same time (bass alone was already 19-39%). Fixed: when the fit runs with `source: 'mic'` (this bench now does, since these are all mic-only singers), `colorChord` leaves every genre as a plain triad instead of maj7/min7/dom7, `chordPattern` (src/patterns/toolkit.ts) caps the keys register at ctx.keysHigh (60, below a typical sung range) instead of the octave-derived ceiling, and drops any keys note a semitone or tritone from ctx.sungPitchClass (the singer's pitch class, sampled every beat here) at that hit. Keys dissonance drops to 15/19/6/28% on the four songs -- three under the 25% target, leon_8 still over. leon_8 holds one fixed chord (no key lock, 0 changes) whose only chord tone inside the narrow octave-4 register below the 60 ceiling is a single pitch class; the per-hit filter avoids it at the sampled instant, but the note then sustains for up to two beats and a real singer's pitch keeps moving underneath it, so some overlap survives even with per-beat sampling. A genuine fix there needs either a wider comping register below the ceiling (tried: widening it to a full 23-semitone window below 60 gave the voicing more chord tones to choose from, but also more simultaneous voices and pushed dissonance up across all four songs, so it was reverted) or shorter keys note durations under a mic singer, neither applied here. "Sung pitch in band chord" is unchanged (still scored against the always-coloured chord, since that measures the harmonic function the band is thinking in, not the mic-aware voicing) -- not worse, as intended.

On the mixes: the voice is mixed 6 dB above the band as the app does, so the clashes are audible but not dominant; the amy_15 pair (following vs static tonic) is the direct A/B, and they sound almost the same, which is what the table says.

## What the columns mean

**Pitch acc %**: 50 ms analysis windows, on frames the MIR-1K label marks as voiced, where the raw McLeod estimate lands within 50 cents of the labelled pitch. **Octave err %**: the miss is an octave up or down. **No pitch %**: the detector returned nothing (below its RMS floor or no clear period). **Other err %**: everything else, mostly frames where the singer is sliding between notes, or the estimate landed on a fifth or a formant.

**Note F1 / P / R**: notes derived from the labels (a run of at least 120 ms within ±50 cents of one semitone) matched against the notes the PitchTracker emitted, same midi and within 400 ms of the labelled start, each used once. "notes (label/det)" is how many notes the labels imply versus how many the tracker emitted. **Latency ms**: median delay from labelled note start to the matched detection.

**Key lock s / key / key plausible**: when KeyDetector first reported a key, what it was, and whether that key's scale contains at least 85% of the labelled pitch classes weighted by duration. **Label key (cov)**: the major/minor scale that covers the most of the sung pitch classes, and how much it covers; a low value there means the singer is not in any one key (or is off by more than 50 cents a lot of the time), so no detector can be "right".

**Tempo lock s / bpm**: when TempoLock (12 onsets, or the 8 s provisional path) first reported a bpm, and what it was. There is no ground-truth tempo in MIR-1K; the singers sang to a karaoke track that is not in the vocal channel.

**Fit table**: each song runs through the listener twice, once to find a tempo and key, once with chord ticks every half bar at that tempo; the lofi pattern bank is then driven bar by bar over the resulting chord timeline (coloured to maj7/min7 the way the bandleader does), with the listener's own dynamics. "Sung pitch in band chord" is the share of voiced label frames whose pitch class is a tone of the chord the band held in that half bar. "Band notes in label key" is the share of bass/keys/lead notes in the scale that best covers the labels. "Dissonant half bars" is the share of half bars (with both a sustained sung note and a bass or keys note) where some bass/keys note is a minor second or tritone against a sung note sounding at the same time. "Static tonic" is the same band told to hold the tonic chord of the same key for the whole song.