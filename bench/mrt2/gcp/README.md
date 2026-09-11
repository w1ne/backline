# MRT2 GPU hosting kit — RunPod (primary), GCP (plan B)

Prepared 2026-09-11, not deployed — no cloud auth exists yet for either
provider on this box. Everything below is checked against current provider
docs (links inline); anything I couldn't confirm is marked `UNVERIFIED`.

Despite the folder name (`gcp/`, kept for path continuity with the original
brief), **the recommended path is RunPod**, not GCP. See §5 for why.

Goal: CPU RTF was 9.9 (bench/mrt2/README.md); we need RTF ≤ 1.0 with
~200ms control latency, reachable from the browser app through the
Cloudflare relay (`relay/src/index.ts`) over a `wss://` URL with a valid TLS
certificate.

---

## 1. Recommendation: RunPod On-Demand Pod (not Serverless)

**Pod, not Serverless, because the workload is a long-lived stateful
WebSocket connection**, not a request/response job:

- RunPod Serverless is built around the queue-worker model: a job comes in,
  a handler runs, the endpoint can scale to zero between calls. A
  Load-Balancer-type Serverless endpoint *can* front a WebSocket, but
  RunPod's own worker-lb-websocket reference and community reports describe
  workers scaling to zero mid-connection because open (idle) WebSocket
  traffic isn't counted as "active work" — the standard fix is pinning
  `min_workers=1`, which is a permanently-billed warm worker anyway, i.e.
  functionally identical to just running a Pod, but with more moving parts.
  (Source: RunPod docs + community reports, `docs.runpod.io`,
  `github.com/runpod-workers/worker-lb-websocket`.)
- A Pod gives one persistent container with a stable process (our shared
  model + warm JAX compilation cache) for the whole hackathon session —
  exactly the "single shared model, per-connection state" design in
  `gcp/serve.py`.
- **Serverless is the right call only if** you need many concurrent
  independent sessions with bursty, unpredictable traffic and are willing
  to eat cold-start-per-session cost. Not this case.

### GPU choice: RTX A5000

| GPU | VRAM | Community Cloud $/hr | Fits mrt2_base? |
|---|---|---|---|
| RTX A5000 | 24GB | **~$0.27/hr** | yes |
| NVIDIA L4 | 24GB | ~$0.39/hr | yes |
| RTX 4090 | 24GB | ~$0.34/hr (Community) | yes |

All three have 24GB VRAM, comfortably ample for `mrt2_base` (2.4B params).
A5000 is cheapest at time of writing; RTX 4090 is a reasonable fallback if
A5000 availability is thin in Community Cloud (spot-like — availability
varies by host). Recommendation: **A5000 first, RTX 4090 as fallback**, on
Community Cloud for a hackathon (Secure Cloud costs more and buys
guaranteed capacity + stable public IP, which matters less for a
short-lived demo). `UNVERIFIED`: exact live price at deploy time — RunPod
prices float; always check `runpod.io/pricing` or the API's
`gpuTypes` query immediately before creating the pod.

Sources: [runpod.io/gpu-models](https://www.runpod.io/gpu-models),
[runpod.io/product/cloud-gpus](https://www.runpod.io/product/cloud-gpus).

---

## 2. Build and push the image to GHCR

Repo is public, so the GHCR package can be public too (no pull secret
needed on the RunPod side).

```bash
cd /home/andrii/projects/backline/bench/mrt2/gcp

# GitHub PAT with `write:packages` scope, or `gh auth token` if the gh CLI
# session already has that scope.
echo "$GHCR_PAT" | docker login ghcr.io -u w1ne --password-stdin

docker build -t ghcr.io/w1ne/backline-mrt2:latest .
docker push ghcr.io/w1ne/backline-mrt2:latest

# after first push, make it public (one-time, via GitHub UI or gh api):
gh api -X PATCH /user/packages/container/backline-mrt2 -f visibility=public
```

Record the built image size (`docker images ghcr.io/w1ne/backline-mrt2`) —
see the Dockerfile's checkpoint-strategy comment for what to do if baking in
`mrt2_base` makes the image too large to push comfortably on hackathon wifi.

---

## 3. Create the pod

### Option A — Web console (fastest for a one-off hackathon pod)

RunPod Console → Pods → Deploy → pick RTX A5000, Community Cloud → Custom
Template → image `ghcr.io/w1ne/backline-mrt2:latest` → expose HTTP port
`8080` → Deploy.

### Option B — `runpodctl` (scriptable, reproducible)

```bash
# API key from RunPod Settings → API Keys. Store it out of the repo:
mkdir -p ~/.local/secrets
# (RUNPOD_API_KEY to be provided into ~/.local/secrets/runpod.env)
source ~/.local/secrets/runpod.env

runpodctl config --apiKey "$RUNPOD_API_KEY"

runpodctl create pod \
  --name mrt2-bench \
  --imageName ghcr.io/w1ne/backline-mrt2:latest \
  --gpuType "NVIDIA RTX A5000" \
  --gpuCount 1 \
  --containerDiskSize 30 \
  --ports "8080/http" \
  --communityCloud
```

`UNVERIFIED`: exact `runpodctl create pod` flag names/spelling — the CLI's
flags have changed across versions; run `runpodctl create pod --help`
against the installed version before using this verbatim, or use the
GraphQL `podFindAndDeployOnDemand` mutation directly
(`docs.runpod.io/sdks/graphql/manage-pods`) if the CLI flags don't match.

### Get the URL

RunPod exposes HTTP/WS ports through its proxy at:

```
wss://<POD_ID>-8080.proxy.runpod.net
```

Find `<POD_ID>` via `runpodctl get pod` or the console. This is the value
that goes into the relay's `MRT2_UPSTREAM` secret (see `relay-route.md`).

**Why the proxy domain and not TCP port exposure**: TCP port exposure gives
a bare `PUBLIC_IP:PORT` with **no TLS** — "implement TLS in your application
when handling sensitive data over TCP" per RunPod's docs. The relay needs a
`wss://` origin with a valid cert, and standing up our own cert/reverse-proxy
inside the container is exactly the kind of extra moving part a hackathon
doesn't need. The proxy domain gets that for free
(`Cloudflare → RunPod LB → pod`, HTTPS/WSS terminated by RunPod/Cloudflare).
Source: [docs.runpod.io/pods/configuration/expose-ports](https://docs.runpod.io/pods/configuration/expose-ports).

**The one real caveat**: RunPod's proxy path enforces a **100-second**
Cloudflare timeout on that connection. Confirmed from RunPod's own docs.
Because MRT2 streams an audio chunk roughly every ~2 seconds once RTF ≤ 1
(and `serve.py`'s generation loop only pauses, never blocks indefinitely,
while `playing=True`), normal operation stays well under 100s of silence on
the wire. Risk case: a client pauses playback and holds the socket open with
no frames for >100s — verify this against real usage before the demo, and if
it's a problem, add a periodic ping frame from `serve.py` (not yet
implemented) rather than switching to raw TCP.

### Checkpoint strategy: baked into the image

See the Dockerfile's inline comment for the full reasoning: baking
`mrt2_base` into the GHCR image (via `mrt checkpoints download mrt2_base` at
build time) avoids a cold-start download from Hugging Face eating billed
GPU-seconds, and avoids the extra complexity of wiring a RunPod network
volume for a single hackathon pod. Fallback if the resulting image is too
large to push/pull comfortably: switch `MRT2_MODEL` build arg to
`mrt2_small` (1.1GB checkpoint, already verified on CPU at RTF 9.9 — the
number we need the GPU to beat). Use a network volume only if you need the
checkpoint to survive a pod being deleted and recreated across multiple
sessions.

### First check: `--bench`, before touching the relay

```bash
# SSH into the pod (RunPod console → Pod → Connect → SSH), or:
runpodctl exec <POD_ID> -- python3 /app/serve.py --bench --model mrt2_base
```

Confirms `jax.default_backend()` reports `gpu`/`cuda` (not `cpu`) and prints
RTF over 20 chunks. If RTF > 1.0 on `mrt2_base`, fall back to `mrt2_small`
and rebuild.

### Teardown

```bash
runpodctl remove pod <POD_ID>
# or: RunPod console → Pods → ⋮ → Terminate
```

Community Cloud pods are billed per second while running — terminate
immediately after the hackathon session, don't just stop the container.

---

## 4. CUDA / JAX setup

`magenta-rt`'s JAX backend picks up CUDA automatically once `jax[cuda12]`
is installed and a CUDA device is visible — no code branch needed; this is
handled by JAX's own device-placement default (see `gcp/serve.py`'s
`load_model()`, which logs `jax.default_backend()` on boot as the
single most important line to check).

- **Pip extra**: `pip install jax[cuda12]` (or `uv pip install "jax[cuda12]"`)
  — confirmed current on `docs.jax.dev/en/latest/installation.html` as of
  2026-09-11. This pulls `jaxlib` + `jax-cuda12-plugin` +
  `jax-cuda12-pjrt` from PyPI's normal index; no special `-i` index URL is
  needed for the stable release (that's only documented for JAX
  *pre-release* nightly builds, via
  `https://us-python.pkg.dev/ml-oss-artifacts-published/jax/simple/`).
- **Requires CUDA 12.1+ driver on the host.** If the underlying host driver
  is CUDA 12.0 or 11.x, `jax[cuda12]` silently falls back to CPU with no
  error — this is exactly the kind of failure `serve.py --bench`'s explicit
  `jax.default_backend()` log line is meant to catch immediately.
  RunPod's GPU hosts run current drivers supporting CUDA 12.4+.
  `UNVERIFIED`: the exact driver version on whichever specific Community
  Cloud host you land on — check `nvidia-smi` on the pod after boot.
- **Pin**: Dockerfile pins `jax[cuda12]==0.4.34` alongside an unpinned
  `magenta-rt` (no published compatibility matrix exists between the two);
  bump both together and re-run `--bench` if you need a newer JAX.
- Note the JAX package-extra naming change: newer JAX releases use dashes
  (`jax[cuda12-local]`) instead of underscores in some extras — not
  relevant to the plain `cuda12` extra used here, but worth knowing if you
  touch the pin later.

---

## 5. Why RunPod over GCP for a hackathon starting now

The blocking issue on GCP is **GPU quota on a fresh project**: `GPUS_ALL_
REGIONS` defaults to 0 on new projects, and while accounts with billing
history/history sometimes get automatic approval, this isn't guaranteed and
there's no published SLA on turnaround — it can be minutes or it can be a
manual-review queue, and "no cloud auth exists yet" here means starting from
zero. A hackathon can't risk sitting in a quota-approval queue.
RunPod has no such quota gate: pods (Pod and Serverless) are available on
signup with a funded account, no separate GPU allocation request.

Also relevant: RunPod's per-second billing and $0.27–0.39/hr GPU pricing is
materially cheaper than GCP's equivalent L4 (`g2-standard-4`) on-demand rate
(~$0.70/hr for the GPU portion), even before accounting for quota delay.

### GCP as plan B (short plan, not executed)

If RunPod turns out to be unavailable (e.g. no Community Cloud capacity for
A5000/4090 at demo time), fall back to a GCE VM, not Cloud Run:

- **Cloud Run w/ GPU**: L4 support is GA, no quota request needed, and
  WebSocket + up-to-60-minute request timeouts are both GA — technically
  workable. But Cloud Run's GPU tier still needs `min-instances ≥ 1` to
  avoid a cold start that would blow past the ~200ms control-latency target
  (cold start = container boot + model load + JAX JIT warm-up, easily
  10–30s), and a billed always-on GPU instance on Cloud Run has no cost
  advantage over a plain GCE VM for a single-session hackathon demo — it
  adds Cloud Run's request-routing layer for no benefit here.
  Source: [cloud.google.com/blog/.../cloud-run-gpus-are-now-generally-available](https://cloud.google.com/blog/products/serverless/cloud-run-gpus-are-now-generally-available).
- **GCE `g2-standard-4` (1x L4, 24GB)**: on-demand ≈ $0.70/hr for the GPU
  (plus vCPU/mem), spot ≈ $0.088–0.15/hr depending on region — cheap, but
  spot preemption risk is a bad trade for a live demo. **This still needs a
  GPU quota increase on a fresh project** (`GPUS_ALL_REGIONS`, default 0);
  budget for an unknown wait unless the project already has billing history
  that grants it automatically.

```bash
# plan-B sketch only, not verified end-to-end
gcloud config set project <PROJECT_ID>
gcloud services enable compute.googleapis.com
gcloud compute instances create mrt2-bench \
  --zone=us-central1-a \
  --machine-type=g2-standard-4 \
  --accelerator=type=nvidia-l4,count=1 \
  --maintenance-policy=TERMINATE \
  --image-family=common-cu124-ubuntu-2204 --image-project=deeplearning-platform-release \
  --boot-disk-size=100GB
gcloud compute firewall-rules create allow-https --allow=tcp:443 --target-tags=mrt2
# teardown:
gcloud compute instances delete mrt2-bench --zone=us-central1-a
```

Don't execute this unless RunPod is confirmed unavailable — it's here so
plan B doesn't cost research time mid-hackathon if needed.

---

## Sources

- [docs.runpod.io/pods/configuration/expose-ports](https://docs.runpod.io/pods/configuration/expose-ports) — proxy vs TCP, 100s timeout, TLS
- [runpod.io/blog/runpod-proxy-guide](https://www.runpod.io/blog/runpod-proxy-guide)
- [docs.runpod.io/sdks/graphql/manage-pods](https://docs.runpod.io/sdks/graphql/manage-pods)
- [runpod.io/gpu-models](https://www.runpod.io/gpu-models), [runpod.io/product/cloud-gpus](https://www.runpod.io/product/cloud-gpus)
- [github.com/runpod-workers/worker-lb-websocket](https://github.com/runpod-workers/worker-lb-websocket) — Serverless WS scale-to-zero issue
- [docs.jax.dev/en/latest/installation.html](https://docs.jax.dev/en/latest/installation.html) — `jax[cuda12]` extra
- [cloud.google.com/blog/products/serverless/cloud-run-gpus-are-now-generally-available](https://cloud.google.com/blog/products/serverless/cloud-run-gpus-are-now-generally-available)
- [docs.cloud.google.com/run/docs/triggering/websockets](https://docs.cloud.google.com/run/docs/triggering/websockets)
- `groups.google.com/g/gce-discussion` thread on `GPUS_ALL_REGIONS` quota default 0
- `bench/mrt2/README.md` (this repo) — CPU baseline RTF 9.9, corrected JAX entry point
