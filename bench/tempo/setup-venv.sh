#!/usr/bin/env bash
# Reference tempo libraries for bench/tempo/libs.py, in a venv next to this script (gitignored).
# librosa (ISC) and Essentia (AGPL) install from wheels. madmom (BSD with a non-commercial
# research clause, see its LICENSE) is installed from the GitHub main archive because the PyPI
# release (0.16.1) does not import on Python 3.12; its model files live in a separate repo
# (a git submodule the archive does not carry), fetched and unpacked into the package. Its
# extension is compiled against the numpy it finds, so numpy is pinned before and after BeatNet
# (torch + BeatNet, attempted last with a time limit; the bench works without it).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
VENV="$HERE/.venv"
[ -d "$VENV" ] || python3 -m venv "$VENV"
PIP="$VENV/bin/pip"
PY="$VENV/bin/python"
"$PIP" install -q --upgrade pip
"$PIP" install -q "setuptools<81" wheel "numpy<2" "scipy<1.14" cython soundfile librosa
"$PIP" install -q essentia || echo "essentia: no wheel for this platform, skipped"
if [ "${WITH_BEATNET:-0}" = "1" ]; then
  timeout 600 "$PIP" install -q --extra-index-url https://download.pytorch.org/whl/cpu torch BeatNet || echo "BeatNet: install failed or timed out, skipped"
  "$PIP" install -q "numpy<2"
fi
"$PIP" install -q --force-reinstall --no-deps --no-build-isolation "madmom @ https://github.com/CPJKU/madmom/archive/refs/heads/main.zip" || echo "madmom: build failed, skipped"
SITE="$("$PY" -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')"
if [ -d "$SITE/madmom" ] && [ ! -f "$SITE/madmom/models/beats/2015/beats_blstm_1.pkl" ]; then
  TMP="$(mktemp -d)"
  curl -sL -o "$TMP/models.zip" https://github.com/CPJKU/madmom_models/archive/refs/heads/master.zip \
    && unzip -q -o "$TMP/models.zip" -d "$TMP" \
    && rm -rf "$SITE/madmom/models" && mv "$TMP/madmom_models-master" "$SITE/madmom/models"
  rm -rf "$TMP"
fi
"$PY" -c "import librosa, scipy, numpy; print('librosa', librosa.__version__, 'scipy', scipy.__version__, 'numpy', numpy.__version__)"
"$PY" -c "import madmom.features.beats; import madmom; print('madmom', madmom.__version__)" || true
"$PY" -c "import essentia.standard; print('essentia ok')" || true
"$PY" -c "import BeatNet; print('beatnet ok')" 2>/dev/null || true
