# ACE-Step block-generation service for Backline.
# GPU base with CUDA 12.4 / Python 3.11, matches what worked on RunPod.
FROM runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    ACESTEP_CHECKPOINTS_DIR=/workspace/models \
    ACE_REPO_DIR=/opt/ace-step \
    PORT=8080

RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg git curl \
    && rm -rf /var/lib/apt/lists/*

RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /opt
RUN git clone https://github.com/ace-step/ACE-Step-1.5.git ace-step \
    && cd ace-step \
    && git checkout ca1e85fe9430179831e6bc6be790c332190a3866 \
    && uv sync

# --- Weights ---
# Baking weights in keeps cold start fast but adds several GB on top of the
# CUDA devel base (~9-10 GB) and the uv-synced deps (~3-4 GB with torch
# already in the base image). Default here is to download at first
# container start into ACESTEP_CHECKPOINTS_DIR (mount a RunPod network
# volume at /workspace so weights persist across pod restarts); pass
# --build-arg BAKE_WEIGHTS=1 to pre-fetch the turbo DiT + VAE + default 5Hz
# LM at build time instead, via the real download helper
# (acestep.api.model_download.ensure_model_downloaded -- verified against
# the ACE-Step 1.5 source; the previous draft called a made-up
# AceStepHandler(checkpoint_dir=...) constructor that doesn't exist).
ARG BAKE_WEIGHTS=0
RUN if [ "$BAKE_WEIGHTS" = "1" ]; then \
        cd /opt/ace-step && mkdir -p ${ACESTEP_CHECKPOINTS_DIR} && \
        uv run python -c "\
from acestep.api.model_download import ensure_model_downloaded; \
[ensure_model_downloaded(m, '${ACESTEP_CHECKPOINTS_DIR}') for m in ('acestep-v15-turbo', 'vae', 'acestep-5Hz-lm-0.6B')]" ; \
    fi

WORKDIR /opt/backline-acestep
COPY requirements.txt ./
RUN /opt/ace-step/.venv/bin/pip install -r requirements.txt
COPY server.py ./

ENV PYTHONUNBUFFERED=1
EXPOSE 8080

CMD ["/opt/ace-step/.venv/bin/python", "server.py"]
