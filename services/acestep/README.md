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

## Verification status

- `python -m py_compile server.py` passes in this environment.
- `docker build` was attempted locally (see below) to validate the
  Dockerfile syntax and the `git clone` + `uv sync` steps; it was not
  run to completion with weight download or GPU access, since this
  machine has no GPU and the point of the build is to run ACE-Step.
- The exact Python API call (`acestep.handler.AceStepHandler`,
  `acestep.inference.generate_music` / `GenerationParams` field names)
  is **unverified** against the ACE-Step-1.5 source at the pinned
  commit -- it was not fetched in this session. `server.py` wraps that
  call defensively and falls back to driving the documented HTTP API
  (`acestep-api` subprocess, `/release_task` + `/query_result`) if the
  in-process import/call raises, so the service should still work even
  if the in-process signature is wrong, at the cost of an extra
  process + HTTP hop.
- 44.1 kHz -> 48 kHz resampling, PCM16 framing, and the WS protocol are
  implemented per the task spec but not exercised end-to-end against a
  live ACE-Step model.
