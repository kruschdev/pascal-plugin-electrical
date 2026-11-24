#!/usr/bin/env bash
# Synthesizes studio voiceover for assets/demo-walkthrough.mp4 using Gemini 3.8 Flash TTS
# (`gemini-api tts`) and muxes it cleanly into assets/demo-walkthrough-narrated.mp4.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VOICE="${VOICE:-Charon}"
MODEL="${MODEL:-gemini-3.8-flash-tts}"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --voice) VOICE="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

IN_MP4="$ROOT_DIR/assets/demo-walkthrough.mp4"
OUT_WAV="$ROOT_DIR/assets/demo-walkthrough-voiceover.wav"
OUT_MP4="$ROOT_DIR/assets/demo-walkthrough-narrated.mp4"
SCRIPT_TMP="$(mktemp /tmp/pascal_electrical_vo_XXXXXX.txt)"
trap 'rm -f "$SCRIPT_TMP"' EXIT

# Extract the clean ```text narration block from docs/WALKTHROUGH-SCRIPT.md
awk '/^```text$/{flag=1; next} /^```$/{flag=0} flag' "$ROOT_DIR/docs/WALKTHROUGH-SCRIPT.md" > "$SCRIPT_TMP"

if [[ ! -s "$SCRIPT_TMP" ]]; then
  echo "Failed to extract narration text from docs/WALKTHROUGH-SCRIPT.md" >&2
  exit 1
fi

if [[ "$DRY_RUN" == "1" ]]; then
  echo "Dry-run preview (zero API cost):"
  gemini-api tts -f "$SCRIPT_TMP" -m "$MODEL" --voice "$VOICE" --out "$OUT_WAV" --dry-run --output-format json
  exit 0
fi

if [[ ! -f "$IN_MP4" ]]; then
  echo "Missing $IN_MP4; run bun run render:walkthrough first." >&2
  exit 1
fi

echo "Synthesizing narration via $MODEL (voice=$VOICE)..."
WAV_PATH="$(gemini-api tts -f "$SCRIPT_TMP" -m "$MODEL" --voice "$VOICE" --out "$OUT_WAV")"
echo "Generated voiceover WAV: $WAV_PATH"

echo "Muxing voiceover into $OUT_MP4..."
ffmpeg -y \
  -i "$IN_MP4" \
  -i "$WAV_PATH" \
  -map 0:v:0 -map 1:a:0 \
  -c:v copy \
  -c:a aac -b:a 192k \
  -movflags +faststart \
  -shortest \
  "$OUT_MP4"

echo "Ready: $OUT_MP4 ($(du -h "$OUT_MP4" | cut -f1))"
