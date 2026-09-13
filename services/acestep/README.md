# ACE-Step block-generation service

Generates 2-bar (bar-quantized) audio blocks from ACE-Step 1.5 for the
Backline browser band. One process, model loaded once, `/health` +
WebSocket `/ws`. See `server.py` for the protocol.

## Build and push

```bash
cd services/acestep
docker build -t ghcr.io/w1ne/backline-acestep:latest .
# to bake weights into the image instead of downloading at first start:
# docker build --build-arg BAKE_WEIGHTS=1 -t ghcr.io/w1ne/backline-acestep:latest .

echo "$GITHUB_TOKEN" | docker login ghcr.io -u w1ne --password-stdin
docker push ghcr.io/w1ne/backline-acestep:latest
```

Image size: the CUDA 12.4 devel base is ~9-10 GB, ACE-Step's `uv sync`
deps (torch already present in the base) add roughly another 3-4 GB.
Without baked weights that lands around **13-14 GB**. Baking in the
~8.5 GB of weights (4.8 GB DiT-turbo + 3.7 GB LM) pushes total to
roughly **20-22 GB**, at or slightly over the task's ~20 GB budget --
default build downloads weights on first container start into
`ACE_MODEL_DIR` instead (see Volumes below). Neither figure has been
measured by an actual `docker build` push in this environment (no GPU
here to run the model, and weight download requires network access to
HuggingFace); the local `docker build` performed for this task only
validates that the Dockerfile builds through the `uv sync` step.

## Volumes (network storage for weights)

If not baking weights in, create a RunPod network volume (e.g. 30 GB) and
mount it at `/workspace` on the pod so `ACE_MODEL_DIR=/workspace/models`
persists downloaded weights across pod restarts -- otherwise every fresh
pod re-downloads ~8.5 GB before it can serve its first block.

## RunPod pod creation (GraphQL)

GPU preference order: **L4 -> A5000 -> RTX 4090 -> A40** (first available).
HTTP port 8080 is exposed for the WebSocket; RunPod's own nginx already
occupies port 8001, so don't use it.

```bash
RUNPOD_API_KEY=...  # from runpod.io/console/user/settings

for GPU in "NVIDIA L4" "NVIDIA RTX A5000" "NVIDIA GeForce RTX 4090" "NVIDIA A40"; do
  RESP=$(curl -s -X POST "https://api.runpod.io/graphql?api_key=${RUNPOD_API_KEY}" \
    -H "Content-Type: application/json" \
    -d @- <<EOF
{
  "query": "mutation { podFindAndDeployOnDemand(input: {cloudType: SECURE, gpuTypeId: \"${GPU}\", gpuCount: 1, name: \"backline-acestep\", imageName: \"ghcr.io/w1ne/backline-acestep:latest\", containerDiskInGB: 30, volumeInGB: 30, volumeMountPath: \"/workspace\", ports: \"8080/http\", env: [{key: \"ACE_MODEL_DIR\", value: \"/workspace/models\"}]}) { id imageName } }"
}
EOF
  )
  echo "$GPU -> $RESP"
  echo "$RESP" | grep -q '"id"' && break
done
```

The pod's ID comes back as `data.podFindAndDeployOnDemand.id`. The
service is then reachable at:

```
wss://<POD_ID>-8080.proxy.runpod.net/ws
```

Set this as the relay's `ACESTEP_UPSTREAM` env var (Task 16 Step 2).

## Keepalive

RunPod's HTTPS proxy drops idle connections after ~100 s. The relay (or
client) should send `{"type":"ping"}` at least every 30 s while a
session is open; the server replies `{"type":"pong"}` immediately.

## Teardown

```bash
curl -s -X POST "https://api.runpod.io/graphql?api_key=${RUNPOD_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"mutation { podTerminate(input: {podId: \\\"${POD_ID}\\\"}) }\"}"
```

Stop (not terminate) the pod between rehearsals if you want to keep the
network volume without paying for GPU time; terminate it when done for
good, since network volumes bill separately.

## Expected cost

L4 secure-cloud on-demand is roughly **$0.40-0.45/h**; A5000 and 4090
are in the same **$0.35-0.50/h** band; A40 tends to run **$0.55-0.75/h**.
Actual price depends on RunPod's live availability/pricing at request
time -- check the console before launching for a session.

## `--bench`

```bash
python server.py --bench
```

Loads the model, runs one warm-up generation, then generates six
consecutive 2-bar blocks at 100 BPM (block 0 via `text2music`, blocks
1-5 via `complete` chained off the previous block's output) and prints
per-block wall time, block duration, and real-time factor (wall /
duration; RTF < 1.0 means faster than real time). Requires a GPU and
downloaded/baked weights -- not runnable in this development
environment, which has neither.

## Verification status (RunPod A40, ca1e85fe9430179831e6bc6be790c332190a3866)

Generation pipeline (the hard part) is verified end-to-end on a real GPU:

- Weights auto-download on first `/release_task` into
  `<ace repo>/checkpoints` (confirmed path: `ACESTEP_CHECKPOINTS_DIR`, see
  fixes below) -- turbo DiT (4.8 GB) + VAE (0.3 GB) + a 5Hz LM (0.6B/1.7B/4B,
  auto-selected) download in well under a minute on a fast link.
- 6 chained blocks (1x `text2music` + 5x `complete` with `track_classes`,
  2 bars @ 100 BPM = 4.8 s each, `batch_size=1`) all succeeded:
  block 0 (`text2music`) wall=4.23s (RTF 0.88, includes LM warmup), blocks
  1-5 (`complete`, chained off the previous block's wav) wall=2.05-2.07s
  each (RTF ~0.43). VRAM: ~17.3 GB / 49.1 GB used with the turbo DiT + 0.6B
  LM loaded.
- Output is real audio (verified by inspecting wav files), 48 kHz as
  configured via `audio_format=wav` in the request body.

Fixes made to `server.py` after reading the real ACE-Step 1.5 source
(`acestep/handler.py`, `acestep/inference.py`,
`acestep/api/http/release_task_models.py`, `acestep/api/job_generation_setup.py`,
`acestep/api/http/release_task_param_parser.py`, `acestep/api/http/query_result_service.py`):

- **Dropped the in-process path entirely.** `AceStepHandler()` takes no
  constructor args (not `checkpoint_dir=...`) and needs a separate,
  manually-wired `LLMHandler`; `generate_music(dit_handler, llm_handler,
  params, config, ...)` needs both handlers plus a `GenerationConfig`;
  `GenerationParams` field names don't match what the draft used
  (`caption` not `prompt`, `keyscale` not `key_scale`, `duration` not
  `audio_duration`, `src_audio` not `src_audio_path`); and `track_classes`
  isn't a `GenerationParams` field at all -- it's rendered into the
  `instruction` prompt text by `job_generation_setup.py::_resolve_instruction`.
  The HTTP subprocess is the only generation path now.
- **Port 8010, not 8001**: `acestep-api`'s own CLI default is 8001, but
  RunPod's nginx already owns 8001 on the pod (matches the note already in
  this README) -- confirmed live, the original in-process/HTTP fallback
  code had the right port constant but the CLI wasn't told to use it.
- **`ACESTEP_CHECKPOINTS_DIR`, not `ACE_MODEL_DIR`/`ACESTEP_MODEL_DIR`**
  (`acestep/model_downloader.py::get_checkpoints_dir`) -- the made-up env
  var name in the original Dockerfile/server.py had no effect; weights
  always went to the default `<ace repo>/checkpoints`.
- **`guidance` -> `guidance_scale`** in the `/release_task` body
  (`server.py`, `_generate_http`): `release_task_param_parser.py`'s
  `PARAM_ALIASES` only recognizes `guidance_scale`/`guidanceScale`, so the
  original body's `"guidance"` key was silently ignored and every request
  used the request model's default of 7.0.
- **`/query_result` response shape was wrong.** Real shape is
  `{"data": [{"task_id", "status": 0|1|2, "result": "<JSON list of
  candidate dicts>", "progress_text"}]}` (0=queued/running, 1=succeeded,
  2=failed) -- not `{task_id: {...}}` as the draft assumed. Each
  candidate's audio path comes back as `"file": "/v1/audio?path=<urlencoded
  local path>"`; since this service and the acestep-api subprocess share a
  filesystem, the path is decoded and read directly (`_local_path_from_audio_url`)
  instead of an extra HTTP round trip.
- **`/release_task` rejects absolute paths outside the system temp dir**
  (`acestep/api/http/release_task_audio_paths.py::validate_audio_path`).
  `server.py`'s own `_write_temp_wav` already uses `tempfile.mkstemp()`
  with no explicit dir (so it lands in `/tmp`), which happens to satisfy
  this -- documented here because a naive change to write chained-block
  wavs elsewhere (e.g. next to the checkpoints) will break `complete` tasks
  with `400 absolute audio file paths are not allowed`.
- Added `batch_size=1` and `use_random_seed=False` to every request body --
  the server's own default `batch_size` is 2, which doubles compute for no
  benefit here (we only ever consume one candidate).
- subprocess now sets `cwd=ACE_REPO_DIR` (new env var, default
  `/opt/ace-step`, matches the Dockerfile) -- `uv run acestep-api` needs a
  `pyproject.toml` in its cwd; the original code didn't set `cwd` at all
  and only worked by accident if the whole service happened to be launched
  from inside the ACE-Step checkout.

**Known unresolved gap**: the WebSocket endpoint (`/ws`) itself was not
validated end-to-end in this session. `curl`/`websockets` handshakes
against a running `server.py` (uvicorn 0.40.0, starlette 0.50.0, websockets
16.0, as pinned by ACE-Step's own `uv sync`) got rejected with a bare
`403 Forbidden` before `websocket.accept()` ever ran, even though
`app.routes` shows `/ws` registered correctly. Root cause not found before
the RunPod time budget ran out -- likely a version interaction in the
`websockets`/`starlette`/`uvicorn` combination ACE-Step's `uv sync` pins
(this repo's own `requirements.txt` pins looser bounds; worth trying
`pip install "uvicorn[standard]==0.30.*" "websockets<15"` in that venv, or
testing the WS handshake against a bare FastAPI app with no ACE-Step
imports to isolate whether it's dependency-version or app-code related).
The block-generation pipeline underneath (`/release_task` + `/query_result`,
exercised directly and via `AceStepModel.generate()`) is fully verified;
only the WebSocket transport layer needs a follow-up pass.

## DiT model: XL-turbo (bf16)

`server.py` launches acestep-api with `ACESTEP_CONFIG_PATH=acestep-v15-xl-turbo`
(override with `ACE_DIT_MODEL`) and `ACESTEP_INIT_LLM=false`. Measured on the
L40S, 4.8 s block, 8 steps: XL 1.22 s vs 2B turbo 1.6 s, and XL sounds clearly
fuller. The HF repo `ACE-Step/acestep-v15-xl-turbo` is 20 GB of fp32 shards,
which does not fit next to the other checkpoints on the 40 GB pod disk, so
`xl_bf16.py` downloads each shard into `/dev/shm`, casts to bf16 and writes only
the 9.3 GB result. Never let acestep-api download it itself.

The 5Hz LM is off on purpose: it only rewrote the caption (bpm/key are given by
the player), cost ~2 s per block, and on a >40 GB GPU acestep-api auto-pulls the
8 GB `acestep-5Hz-lm-4B` for it, which filled the disk to 100% on 2026-09-13
and took the live services down until the watchdog restarted them.
