# Local AMT on Raspberry Pi 5

The Pi runs `stanford-crfm/music-small-800k` locally, without a cloud relay,
CUDA, or ACE-Step. It accepts the same `start`, `notes`, `set`, and `bar`
frames as the web AMT engine and returns `plan`/`status` frames at `/amt`.
The browser still performs audio capture, pitch detection, and synthesis.
The model consumes detected performer notes, not raw audio waveforms.
No accompaniment is requested until at least one performer note is received.
The health endpoint allows browser requests from the Pi UI at localhost or
127.0.0.1, port 8088.

## Measured CPU results

Measured on the connected Raspberry Pi 5, 8 GB, ARM64, Debian 12,
Python 3.11.2, PyTorch 2.6.0+cpu. Benchmark host date: 2026-09-12;
the Pi's wall clock was four days behind, so log timestamps differ.
100 BPM, four-beat windows: each plan has a 2.4-second scheduling deadline.
The initial runs below use an 80% generation budget, but complete an event
before checking its deadline again. Timing includes the first inference;
checkpoint load timings used an already-warm filesystem cache.

| Variant | Generated windows | Median / max seconds | Late windows | Keys notes/s | Peak RSS MiB |
|---|---:|---:|---:|---:|---:|
| Existing full-prefix sampler | 3 | 2.313 / 2.724 | 1 | 0.71 | 1024 |
| KV cache, full output head | 7 | 2.225 / 2.382 | 0 | 1.60 | 1005 |
| KV cache, one CPU thread | 7 | 2.153 / 2.297 | 0 | 1.61 | 1007 |
| KV cache, dynamic int8 | 7 | 2.086 / 2.261 | 0 | 1.41 | 1784 |
| Final float32, restricted output projection | 15 | 1.812 / 2.204 | 0 | 2.18 | 865 |

All standalone generation windows in these runs contained notes. The first listen-only
window is excluded from these summaries. Notes/s counts committed **model keys
notes**, excluding the rule-based supporting bass note. Raw JSON files preserve
actual note plans, timings, context sizes, and parameters. The early shared
sampler's `tokensPerSec` field was incorrect because it subtracted padded
history from an unpadded result; use notes/s for those comparisons. The final
cached sampler counts actual sampled tokens, including a terminating time token.

These are short synthetic melody benchmarks, not a claim of reliable real-time
performance with every microphone, browser workload, tempo, or musical input.
100 BPM left limited headroom in the worst measured window. Faster tempos have
shorter deadlines. Musical quality has not been established by these timing tests.

## Implementation

`services/pi/amt_backend.py` reuses `services/amt/server.py`'s Session,
`services/amt/arrangement.py`, and the event vocabulary and scheduling utilities
in `bench/amt`. The Pi sampler keeps GPT-2 KV state within a generated window,
projects only the final hidden state, computes output weights only for the
current time/duration/note event kind, and stops as soon as a generated time is
outside the requested window. Safe/instrument/nucleus masks remain in place.
Tests compare cached logits and restricted-head logits with the original full
model output. Dynamic int8 remains opt-in and is not the installed default.

Receiving WebSocket frames is independent of the inference worker; a bounded
queue preserves incoming notes for the next generation. Model execution is
serialized across clients. This is intended for one active duet session; a
second active session competes for the same CPU. The backend does not access
ALSA: the transitive musicpy dependency uses SDL's dummy audio driver.

## Installed layout and controls

- `/home/test/duet-ai-model/venv`: isolated Python environment.
- `/home/test/duet-ai-model/model`: local config and 488 MiB checkpoint.
- `/home/test/duet-ai-model/repo`: required shared AMT code and Pi backend.
- `/home/test/duet-ai-model/wheels`: offline ARM64 wheelhouse.
- `/home/test/duet-ai-model/requirements-installed.txt`: exact installed versions.
- `duet-amt.service`: enabled system unit, runs as `test`, binds `127.0.0.1:18081`.

```bash
sudo systemctl status duet-amt
curl http://127.0.0.1:18081/health
journalctl -u duet-amt -n 50
sudo systemctl stop duet-amt
```

The unit template is `services/pi/duet-amt.service`. Its absolute paths match
this Pi installation. A deployment must include `services/amt/*.py` and
`bench/amt/*.py` alongside `services/pi/amt_backend.py`; copying only the Pi
backend is insufficient. Keep the web/public build's backend configuration
separate from the Pi build.

For an offline reinstall, copy the wheelhouse, checkpoint, source tree, and
anticipation source from the staging machine, then on the Pi:

```bash
python3 -m venv /home/test/duet-ai-model/venv
/home/test/duet-ai-model/venv/bin/pip install --no-index \
  --find-links /home/test/duet-ai-model/wheels \
  -r /home/test/duet-ai-model/repo/services/pi/requirements-amt.txt wheel
/home/test/duet-ai-model/venv/bin/pip install --no-index --no-build-isolation \
  --no-deps /home/test/duet-ai-model/anticipation-main
sudo install -m 0644 /home/test/duet-ai-model/repo/services/pi/duet-amt.service \
  /etc/systemd/system/duet-amt.service
sudo systemctl daemon-reload
sudo systemctl enable --now duet-amt
```

Anticipation source revision: `af37397922665a0fb8d474d7988b0f3755a38d45`.
Checkpoint revision: `fa800530aa1126dd6b58b38f3bdb8fcec9c9d4f5`.
Checkpoint SHA-256:
`45af5006d529a19af3654c729192c072f3aeb9e7e13e9eaf92c19bfd7c87e4d8`.

When downloading ARM64 wheels from an x86 PC, download torch with `--no-deps`
separately: pip evaluates some environment markers against the downloading
host and otherwise requests unnecessary x86 CUDA packages. The Pi installation
resolves the correct CPU dependencies from the wheelhouse. No system Python
packages or system network configuration need to change.

## Verification and reproduction

```bash
cd /home/test/duet-ai-model/repo
/home/test/duet-ai-model/venv/bin/python -m unittest discover \
  -s services/pi -p test_amt_backend.py
# Offline isolated benchmark: do not run concurrently with another inference workload.
AMT_SAMPLER=cached AMT_BUDGET_FRACTION=0.8 /home/test/duet-ai-model/venv/bin/python \
  services/pi/benchmark_amt.py --bars 16 --output final-cached.json
# Existing service benchmark, at real bar cadence, including WebSocket round trip.
/home/test/duet-ai-model/venv/bin/python services/pi/benchmark_amt.py \
  --url ws://127.0.0.1:18081/amt --bars 16 --output service.json
```

`AMT_SAMPLER=baseline`, `AMT_THREADS=1`, and `AMT_QUANTIZE=1` select comparison
modes in separate processes. Historical intermediate results are retained for
transparency; the current cached sampler includes all optimizations, so its
results will differ from the intermediate `cached.json` run. Optional model
tests skip on a PC without AMT dependencies; use the Pi venv to execute them.

## Concurrent renderer test and installed sampling budget

With the Pi browser playing Patterns at 100 BPM and microphone capture enabled,
a 15-window real-cadence WebSocket run at budget 0.8 measured median 2.147s,
max 2.487s, one late window, and three empty windows (`combined-stable-renderer.json`).
This shows that standalone results do not establish live reliability.

A conservative `AMT_BUDGET_FRACTION=0.6` run targeted 1.44 seconds of sampling
at 100 BPM. It measured median 1.667s, max 1.949s, zero late windows, but seven
empty windows out of 15 and only 0.31 keys notes/s (`combined-budget60.json`).
Service RSS after the run was 802 MiB; temperature 58.7°C, no throttling.
Reducing the budget deliberately trades accompaniment density for scheduling headroom. The
sampler still completes its current event, so the fraction is a target rather
than a hard timeout. Configurable range: 0.2–0.8. Sampling is stochastic, so
service runs can differ musically and in note count from the seeded offline test.

The budgets were tested with stochastic service sampling, not repeated identical
random draws. Differences in empty windows and note count therefore cannot be
attributed solely to the budget; these short runs are operational evidence, not
a controlled musical-quality comparison.

The final 0.7 compromise measured median 2.124s, max 2.932s, two late windows,
and 14 empty windows out of 15 (`combined-budget70.json`); service RSS 802 MiB,
58.2°C, no throttling. It did not establish an improvement. The installed
setting was restored to **0.8**, which had the best note coverage in these
service trials, while retaining its documented deadline miss. **Patterns
remains the recommended default; local AMT remains experimental.**

A remaining context limitation was identified during inspection: the shared
`ops.pad` helper pads from absolute time zero even after old musical events
are pruned, creating increasing leading REST history. The cached sampler
bounds the input to 1017 tokens, but does not remove this artificial leading
silence. Its contribution to long-session timing or silence has not been
isolated experimentally; rebasing padding to the retained context is future
work, not a validated change in this port.
