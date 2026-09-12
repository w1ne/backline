# Cloud duet on web and Pi

The performer supplies the melody; accompaniment supports the harmony and leaves space, answering in gaps. The user clarified that all model inference runs on RunPod. The Pi captures MIDI/audio and plays locally synthesized notes or streamed model audio. The public browser uses the same cloud service. Preserve Arturia controls and sampled keyboard sounds.

Choose the default using measured RunPod inference latency, nonempty response coverage and musical constraints. Compare small and medium AMT with identical melodies; evaluate MRT2 runtime feasibility before promising it. ACE remains an optional RunPod texture engine; Lyria is not offered because it requires Google inference, distinguished from note-following accompaniment. No automatic claim that larger means musically better.

The UI foregrounds Your instrument and Your band, connection and actual accompaniment status, style and amount, tempo/key. Advanced controls contain model and routing information. Pi remote controller matches the visual language and exposes instrument, noise and drone controls. It must identify that playback is on the pedal.

AMT must not report an empty plan as its first output. Enabled parts must not falsely claim audible activity. AMT currently only schedules keys/bass: give its rhythm section explicit local pattern ownership, avoiding duplicate bass. Model-selected notes should be constrained to detected harmony while supporting the performer; answers remain short. Disconnection is visible and offline Patterns stays available.

Validation: regression tests for empty plans, model timing and harmony, control validation, both builds, relay checks; real browser MIDI through Pi to scheduled accompaniment and recorded hardware output; public browser MIDI through relay. Keep reproducible model comparison evidence and document limits. Deploy verified changes to Pi and public main under existing user authorization to keep merging and deploy both editions.
