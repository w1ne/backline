# Neutone / LYDIA morph output

Backline can send chosen parts to a **second** audio output, so a hardware timbre-transfer
box — a Roland/Neutone LYDIA on the interface's outputs — hears only those parts while the
rest of the band stays dry on the laptop's output.

**Hook-up.** Interface outputs 3/4 → LYDIA in → LYDIA out → PA (or back into the interface
on a spare input). Outputs 1/2 stay on the PA as the dry band. Both signals meet in the PA,
not in the browser, so the morphed part has its own level and its own channel.

**Picking the output.** In the MANUAL panel, `MORPH OUT` lists every output device the OS
reports (built-in, HDMI, the interface's output pairs); "off" turns the morph bus off again.
The choice is remembered. It needs `setSinkId()`, which today means Chrome or Edge — the
picker disables itself and says so in any other browser. Device names only appear after the
mic permission has been granted, so power the app on once if the list reads "Output 1/2/3".

**What to morph.** The small **M** key on each pad cycles that instrument through
main → morph → both (grey LED / pink / half-and-half). `BAND → MORPH` does the same for the
generated stream from Lyria and ACE, as one bus. Choosing an output for the first time puts
**keys and lead** on it, which is what these models are good at: sustained, pitched, one voice
at a time. Drums do not survive timbre transfer, and bass loses its bottom. `both` is for
auditioning — dry and morphed at once.

**Latency.** The morph path renders into a MediaStream and plays it through a hidden
`<audio>` element, which re-buffers: **~20–50 ms** behind the main output, before LYDIA's own
latency. Against a separate amp that offset is inaudible; in `both` mode it is a short,
audible doubling, so use `both` to choose a sound and not to play a set.

# Mic and MIDI inputs

`MIC IN` picks which input device the Listener hears (the interface, not the laptop's built-in
mic, is usually what you want); echo cancellation, noise suppression and AGC are off on every
device, since all three fight onset detection. Switching mid-song restarts only the audio
stream — the tempo lock, key and chord survive it.

`MIDI IN` lists the connected keyboards by name and defaults to "all". The LCD names the ones
it is listening to (`MIDI ✓ Minilab3 MIDI`). An Arturia MiniLab 3 is class-compliant USB MIDI:
no driver needed, and it can be plugged in before or after Power — hot-plug is handled. Chrome
asks for MIDI permission the first time, and that prompt has to be accepted or the keyboard
never appears in the list.
