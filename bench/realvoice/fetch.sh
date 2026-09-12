#!/usr/bin/env bash
# Downloads only the MIR-1K files bench/gate.ts's realvoice subset needs (8 clips + the 4
# stitched songs' component clips, listed in bench/thresholds.json), from a Hugging Face
# mirror of the dataset, into bench/realvoice/data/MIR-1K/{Wavfile,PitchLabel}/.
#
# Never fails the build: on any network/host problem it prints a warning and exits 0, leaving
# the dataset absent so bench/gate.ts skips the real-voice checks with its own warning.
#
# Usage: bench/realvoice/fetch.sh
# Override the mirror with: HF_MIRROR=https://huggingface.co/datasets/<org>/<repo>/resolve/main
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$HERE/data/MIR-1K"
HF_MIRROR="${HF_MIRROR:-https://huggingface.co/datasets/qingyun/MIR-1K/resolve/main}"

warn_skip() {
  echo "WARNING: $1 -- real-voice gate will skip (see bench/realvoice/dataset.ts)." >&2
  exit 0
}

command -v curl >/dev/null 2>&1 || warn_skip "curl not available"
command -v node >/dev/null 2>&1 || warn_skip "node not available"

# The song -> component-clips mapping mirrors bench/realvoice/dataset.ts's SONGS constant.
# Keep this in sync with dataset.ts if a song's clip list ever changes.
declare -A SONG_CLIPS=(
  [amy_15]="amy_15_01 amy_15_02 amy_15_03 amy_15_04"
  [yifen_1]="yifen_1_01 yifen_1_02 yifen_1_03 yifen_1_04 yifen_1_05 yifen_1_06"
  [abjones_2]="abjones_2_01 abjones_2_02 abjones_2_03 abjones_2_04"
  [leon_8]="leon_8_01 leon_8_02 leon_8_03 leon_8_04 leon_8_05"
)

# Clip names needed: the gate's subsetClips (bench/thresholds.json) plus every clip that makes
# up the gate's songs.
SUBSET_CLIPS="$(node -e "console.log(require('$HERE/../thresholds.json').realvoice.subsetClips.join('\n'))" 2>/dev/null)"
SONG_NAMES="$(node -e "console.log(require('$HERE/../thresholds.json').realvoice.songs.join('\n'))" 2>/dev/null)"

if [ -z "$SUBSET_CLIPS" ] || [ -z "$SONG_NAMES" ]; then
  warn_skip "could not read bench/thresholds.json"
fi

ALL_CLIPS="$SUBSET_CLIPS"
for song in $SONG_NAMES; do
  ALL_CLIPS="$ALL_CLIPS
$(echo "${SONG_CLIPS[$song]:-}" | tr ' ' '\n')"
done
CLIP_NAMES="$(echo "$ALL_CLIPS" | sed '/^$/d' | sort -u)"

mkdir -p "$DATA_DIR/Wavfile" "$DATA_DIR/PitchLabel"

FAILED=0
while IFS= read -r name; do
  [ -z "$name" ] && continue
  wav="$DATA_DIR/Wavfile/$name.wav"
  pv="$DATA_DIR/PitchLabel/$name.pv"
  if [ ! -f "$wav" ]; then
    if ! curl -fsSL "$HF_MIRROR/Wavfile/$name.wav" -o "$wav.tmp"; then
      rm -f "$wav.tmp"; FAILED=1; echo "failed to fetch Wavfile/$name.wav" >&2; continue
    fi
    mv "$wav.tmp" "$wav"
  fi
  if [ ! -f "$pv" ]; then
    if ! curl -fsSL "$HF_MIRROR/PitchLabel/$name.pv" -o "$pv.tmp"; then
      rm -f "$pv.tmp"; FAILED=1; echo "failed to fetch PitchLabel/$name.pv" >&2; continue
    fi
    mv "$pv.tmp" "$pv"
  fi
done <<< "$CLIP_NAMES"

if [ "$FAILED" -ne 0 ]; then
  rm -rf "$DATA_DIR"
  warn_skip "one or more files failed to download from $HF_MIRROR"
fi

echo "MIR-1K subset ready under $DATA_DIR"
