# Pitch tracking repairs

Raw confident estimates now vote in a median window without folding every octave
back to the previous note. A single harmonic outlier is still rejected; a sustained
real octave change is accepted. Below-profile clarity and invalid frequencies count
as dropouts and expire after three polls. Accepted medians update cents even when
the nearest MIDI note is unchanged. Initial acquisition needs the agreement count,
not a completely filled history window (two polls for voice). Existing slide
filtering and duration-weighted key detection are retained.

The microphone now uses the pitch detector's frame-energy/clarity gates instead of
rejecting everything below 0.01 RMS from a different onset-analysis hop. The raw
performer pitch reaches AMT and harmony detection unchanged; accompaniment shaping
continues to constrain generated output separately.

Regression tests cover octave changes in both directions, isolated octave errors,
unclear-input expiry, bends, acquisition, quiet input through MicSource, and an
out-of-key note reaching listener subscribers. The merged suite passes 635 tests.
Both web and Pi production builds pass.

A Chromium fake-microphone test feeds a 48kHz PCM signal at .004 peak amplitude:
220Hz, 440Hz, a 20-cent bend above 440Hz, and silence. The actual browser microphone
pipeline reports MIDI 57 then 69, the bend, and null on silence, with no application
errors. browser-results.json retains the observations. This is a controlled signal
check, not a claim of perfect accuracy on polyphonic or noisy recordings.
