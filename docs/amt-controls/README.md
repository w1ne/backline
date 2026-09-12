# AMT controls and tempo repair

AMT remains the primary RunPod engine. The previous creativity range only varied
nucleus sampling from .75 to .95, followed by chord-only shaping; amount scaled
future velocities but never reached the model service. Tempo reconnection also
lost the current controls.

- Creativity spans temperature .90–1.30 and top-p .85–.99. Higher settings keep
  diatonic passing tones between strong beats and unlock sixteenth-note timing.
- Band amount applies a 30ms gain ramp to every band output bus, including
  scheduled notes and MORPH routes. The keyboard monitor is independent.
  The server also uses amount for phrase density; zero emits no arranged notes.
- Onsets and durations are quantized in beats at the session BPM. Lower creativity
  uses an eighth-note grid; higher creativity uses sixteenths. Simple harmony stays
  chord based; adventurous offbeat notes stay in the detected key.
- Tempo restart clears old scheduled synthesis, resends all controls, and anchors
  model playback to the actual first transport downbeat.

Gain changes are immediate; new phrase choices take effect in the next uncommitted
model plan. AMT still generates note events rendered by the existing instrument
sounds; creativity changes the phrase, not the instrument sample.

Validation: regression tests cover wire controls after tempo change, immediate
routed gain, density, harmonic variation, and beat alignment at 80/133/180 BPM.
`benchmark.py` compares seeded RunPod model output at 100/150 BPM.

RunPod Small results (36 seeded plans): all met the bar deadline and beat-grid
checks. At low creativity, amount .15 versus 1 increased average note count from
1.08 to 1.58. At full amount, creativity 1 averaged 2.83 notes with six diatonic
passing notes across 12 trials, versus none at creativity 0. Low-creativity plans
were nonempty in 8/12 trials; high creativity in 12/12. Rests remain possible.
Median inference was 87–92ms; maximum 479ms including the first cold inference.
These measurements establish control effects and timing, not subjective musical
quality. Exact plans are retained in results.json.
