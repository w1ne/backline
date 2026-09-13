#!/usr/bin/env bash
# Reference tempo libraries for bench/tempo/libs.py, in a venv next to this script (gitignored).
# librosa (ISC) and Essentia (AGPL) install from wheels; madmom (BSD with a non-commercial
# research clause, see its LICENSE) builds from source and needs numpy 1.x and Cython; BeatNet
# pulls torch and is attempted last with a time limit, the bench works without it.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
VENV="$HERE/.venv"
[ -d "$VENV" ] || python3 -m venv "$VENV"
PIP="$VENV/bin/pip"
PY="$VENV/bin/python"
"$PIP" install -q --upgrade pip
"$PIP" install -q "numpy<2" "scipy<1.14" cython soundfile librosa
"$PIP" install -q essentia || echo "essentia: no wheel for this platform, skipped"
"$PIP" install -q madmom || echo "madmom: build failed, skipped"
"$PY" -c "import librosa, scipy; print('librosa', librosa.__version__, 'scipy', scipy.__version__)"
"$PY" -c "import madmom; print('madmom', madmom.__version__)" || true
"$PY" -c "import essentia.standard; print('essentia ok')" || true
if [ "${WITH_BEATNET:-0}" = "1" ]; then
  timeout 600 "$PIP" install -q --extra-index-url https://download.pytorch.org/whl/cpu torch BeatNet || echo "BeatNet: install failed or timed out, skipped"
  "$PY" -c "import BeatNet; print('beatnet ok')" || true
fi
