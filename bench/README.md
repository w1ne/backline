# bench

Offline benches for the listener/harmony/patterns pipeline. Each subfolder is `npm run
bench:<name>`; it prints a table and writes `RESULTS.md` next to itself.

- `voice/` — synthesized vocal clips through the real pitch/onset pipeline.
- `harmony/` — voice leading and chord colouring over a couple of progressions.
- `patterns/` — pattern-bank variety and SongForm transitions.
- `realvoice/` — MIR-1K amateur singers (needs the dataset, not in git; see
  `realvoice/dataset.ts`).

## Benchmarks and gates

`npm run bench:gate` (`bench/gate.ts`) runs the voice, harmony and patterns benches
programmatically and checks their numbers against the floors/ceilings in
`bench/thresholds.json`. If the MIR-1K dataset is present under
`bench/realvoice/data/MIR-1K/` it also runs a fixed 8-clip / 4-song real-voice subset with its
own thresholds; if the dataset is missing, that part is skipped with a warning instead of
failing. Any failing check prints a table row and how far off it was, and the process exits 1.

This is a regression gate, not a quality bar: the thresholds are the currently-recorded numbers
minus a small margin, not a target. A real, reviewed improvement to a bench number should come
with an update to `bench/thresholds.json` in the same change; a gate failure otherwise means
something got worse.

CI runs `npm run bench:gate` as its own job before the build/deploy steps, on every push
(`preview.yml`) and on `main` before the site deploys (`deploy.yml`). It caches the MIR-1K
subset (`actions/cache`, key `mir1k-subset-v1`) and populates it with `bench/realvoice/fetch.sh`,
which downloads only the files that subset needs and never fails the build if the download
doesn't work.

To run the real-voice gate locally, put the MIR-1K dataset's `Wavfile/` and `PitchLabel/` under
`bench/realvoice/data/MIR-1K/` (see `realvoice/dataset.ts`), or run `bash
bench/realvoice/fetch.sh` to fetch just the subset. `npm run bench:realvoice -- --subset` runs
the full real-voice bench script (with `RESULTS.md` output) over that same 8-clip/4-song subset,
without needing fluidsynth/ffmpeg.
