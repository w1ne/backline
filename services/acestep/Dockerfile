# ACE-Step block-generation service for Backline.
# GPU base with CUDA 12.4 / Python 3.11, matches what worked on RunPod.
FROM runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    ACE_MODEL_DIR=/workspace/models \
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
# Baking weights in keeps cold start fast but adds ~8.5 GB (4.8 GB DiT-turbo +
# 3.7 GB LM) on top of the CUDA devel base (~9-10 GB) and the uv-synced deps
# (~3-4 GB with torch already in the base image) -- roughly 20-22 GB total,
# right at the edge of the "~20 GB" budget in the task brief. Default here is
# to download at first container start into ACE_MODEL_DIR (mount a RunPod
# network volume at /workspace so weights persist across pod restarts); pass
# --build-arg BAKE_WEIGHTS=1 to bake them in instead if registry/pull time
# matters more than image size.
ARG BAKE_WEIGHTS=0
RUN if [ "$BAKE_WEIGHTS" = "1" ]; then \
        cd /opt/ace-step && mkdir -p ${ACE_MODEL_DIR} && \
        uv run python -c "from acestep.handler import AceStepHandler; AceStepHandler(checkpoint_dir='${ACE_MODEL_DIR}').load()" ; \
    fi

WORKDIR /opt/backline-acestep
COPY requirements.txt ./
RUN /opt/ace-step/.venv/bin/pip install -r requirements.txt
COPY server.py ./

ENV PYTHONUNBUFFERED=1 \
    PYTHONPATH=/opt/ace-step
EXPOSE 8080

CMD ["/opt/ace-step/.venv/bin/python", "server.py"]
