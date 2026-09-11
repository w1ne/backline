# MRT2 GPU serving image — provider-agnostic (RunPod pod primary target;
# also runs unchanged on a GCE VM or Cloud Run w/ GPU, see README.md).
#
# Base: CUDA 12 devel image (not runtime) because `uv pip install jax[cuda12]`
# needs `nvcc`/headers available at *first-run* JIT compile time on some
# jaxlib versions, and the extra ~2GB is cheap next to the checkpoint weights
# baked in below. UNVERIFIED: whether the currently pinned jax-cuda12-plugin
# actually needs nvcc present at runtime vs. only at jaxlib's own build time —
# devel is the safe choice; switch to a `-runtime` base and re-run
# `serve.py --bench` if you want to shrink the image and confirm it still works.
FROM nvidia/cuda:12.4.1-devel-ubuntu22.04

# ---- checkpoint strategy: BAKE IN AT BUILD TIME ----
# Chosen over "download at start to a mounted volume" because:
#   - RunPod pods billed by the second: every extra minute of cold-start
#     downloading a ~5-10GB checkpoint from Hugging Face is wasted GPU-$.
#   - A RunPod pod's container disk is ephemeral by default; wiring a
#     persistent network volume just to cache weights adds a second moving
#     part (attach it, mount path, first-run-populates-it logic) for a
#     hackathon timeline where "docker run and it just works" matters more
#     than image portability.
#   - GHCR (ghcr.io/w1ne/backline-mrt2) has no image size limit that would
#     bind here; a 10-15GB image is normal for ML serving images.
# UNVERIFIED: exact on-disk size of `mrt2_base`'s safetensors checkpoint —
# the repo's README only states the combined HF repo (both checkpoints +
# SpectroStream codec + MusicCoCa embedder) at ~15.6GB. Build this image,
# check `docker images` for the actual size, and record it in README.md's
# "image size" line — if baking in mrt2_base pushes the image past ~15GB in
# a way that makes GHCR push/pull painful on hackathon wifi, switch
# MRT2_MODEL below to mrt2_small (1.1GB, already verified on CPU) and accept
# the RTF/quality tradeoff instead.
ARG MRT2_MODEL=mrt2_base
ENV MRT2_MODEL=${MRT2_MODEL}
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.12 python3.12-venv curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app
RUN uv venv --python 3.12 /app/.venv
ENV PATH="/app/.venv/bin:${PATH}"

# jax[cuda12]: pip extra confirmed current on docs.jax.dev as of 2026-09-11
# (`pip install jax[cuda12]` pulls jaxlib + jax-cuda12-plugin + jax-cuda12-pjrt
# from PyPI; no special index URL needed for the stable release channel —
# the `-i https://us-python.pkg.dev/...` index is only for JAX *pre-release*
# builds, not needed here). Requires CUDA 12.1+ driver on the host; the
# nvidia/cuda:12.4.1 base plus RunPod's host driver (RunPod's GPU hosts run
# recent drivers supporting CUDA 12.4+) satisfy this.
# UNVERIFIED / pin note: no exact magenta-rt<->jax version compatibility
# matrix is published. Pin both explicitly here so a future `jax` release
# can't silently break the installed `magenta-rt`; bump together and re-run
# `serve.py --bench` if you need a newer jax for another reason.
RUN uv pip install \
        "magenta-rt" \
        "jax[cuda12]==0.4.34" \
        "websockets>=12" \
        "numpy" \
        "psutil"

# ---- bake in the checkpoint ----
# `mrt checkpoints download <model>` is the JAX-path command per the repo
# README's corrected entry points (NOT `mrt models download`, which fetches
# the MLX-format checkpoint the JAX backend cannot load).
RUN mrt checkpoints download ${MRT2_MODEL}

COPY serve.py /app/serve.py

ENV MRT2_MODEL=${MRT2_MODEL}
# $PORT is respected if the platform sets it (Cloud Run does); default 8080
# matches RunPod's and GCE's conventions for an exposed HTTP/WS port.
ENV PORT=8080
EXPOSE 8080

# No CMD-level shell wrapping needed; serve.py reads $PORT and $MRT2_MODEL
# itself, so the same image works unmodified across RunPod / GCE / Cloud Run.
CMD ["python3", "/app/serve.py"]
