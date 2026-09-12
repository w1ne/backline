# Creativity bench

`python3 bench_creativity.py` runs 200 seeded random note windows (same
seed every time) through `shape_notes` at creativity 0.0 .. 1.0 in 0.1
steps, key `C major` over chord `Am`, `amount=0.8`.

| creativity | notes/bar | strong-beat -> chord tone | off-strong -> non-chord scale tone |
|---:|---:|---:|---:|
| 0.0 | 6.25 | 100.0% | 0.0% |
| 0.1 | 6.25 | 100.0% | 0.0% |
| 0.2 | 6.25 | 100.0% | 0.0% |
| 0.3 | 6.25 | 100.0% | 0.0% |
| 0.4 | 6.25 | 100.0% | 0.0% |
| 0.5 | 6.25 | 100.0% | 58.6% |
| 0.6 | 6.25 | 100.0% | 58.6% |
| 0.7 | 5.80 | 100.0% | 58.1% |
| 0.8 | 5.80 | 46.4% | 58.1% |
| 0.9 | 5.80 | 46.4% | 58.1% |
| 1.0 | 9.06 | 47.2% | 58.3% |

Reading it:

- **0.0 - 0.4**: pure chord-tone mode, notes/bar flat. All strong-beat
  and off-beat notes are chord tones.
- **0.5**: off-strong-beat notes are allowed to become non-chord scale
  tones (the existing "passing tone" behavior); strong beats still lock
  to the chord.
- **0.65 / 0.7**: the grid tightens from 0.5 to 0.25 beat, which
  slightly *lowers* notes/bar here because the amount-driven minimum
  spacing (gap) still dominates over the finer grid -- the grid gets
  finer but the floor on how close two notes can sit doesn't move yet.
- **0.8 - 0.9**: the new wild zone opens up -- strong beats may now also
  take scale tones (strong -> chord share drops from 100% to ~46%,
  never below scale-membership). Density hasn't visibly moved yet at
  this `amount` because the spacing floor (`gap`) is still above the
  0.25-beat grid for most of that range.
- **1.0**: the spacing floor reaches exactly the 0.25-beat grid, and
  notes/bar jumps from 5.80 to 9.06 (+56% over 0.7's value) -- the
  density-cap payoff shows up right at the top of the range, which is
  where "wild" is supposed to feel different from "adventurous."

In short: the wild zone's harmonic loosening (strong beats -> scale
tones) phases in gradually from 0.8, but its density payoff is
concentrated at the very top of the range because it comes from closing
the gap between the amount-driven spacing floor and the 0.25-beat grid,
and for `amount=0.8` that floor doesn't cross the grid until
creativity is very close to 1.0. Lower `amount` values close that gap
earlier (see `WildCreativityTests` in `test_arrangement.py`, which uses
`amount=0.3` and already sees a density increase between 0.79 and 1.0).

## Proposed follow-up for server.py (not implemented here)

This bench doesn't show temperature/top-p as a bottleneck at all --
today's mapping (temperature 0.9..1.3, top-p 0.85..0.99 linear over
creativity 0..1) is already generating a wide spread of onsets/pitches;
what actually gates how "wild" the output sounds is the arrangement
filter's spacing floor and tone-set restriction, which this change now
loosens only above 0.8. If a future bench run against the live model
shows temperature/top-p saturating before 0.8 (i.e. the model is
already maximally exploratory well before the filter loosens), the
matching move in `server.py` would be to give temperature/top-p the
same "wild" knee: hold the current 0.9..1.3 / 0.85..0.99 linear ramp
unchanged for creativity in [0, 0.8], then let temperature reach
further (e.g. up to ~1.5) and top-p approach 1.0 only in the last 20%
of the range, mirroring the arrangement filter's own knee at 0.8 so the
two knobs open up together rather than the model maxing out its
sampling entropy long before the filter lets any of it through.
