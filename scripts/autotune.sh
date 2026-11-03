#!/usr/bin/env bash
# Probe the host hardware, write webgui/hardware.json for the GUI, and rewrite
# the engine tuning block in .env (llama-server flags).
#
# The profile is deliberately conservative:
#   - VRAM reserves 1 GiB for the desktop compositor
#   - RAM reserves 6 GiB for the OS and browser
#
# Usage: ./scripts/autotune.sh
# Writes: webgui/hardware.json   (profile for the GUI)
#         .env                   (LLAMA_* tuning block)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"
HW_FILE="$ROOT/webgui/hardware.json"

log()  { printf '\033[1;34m[autotune]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[autotune]\033[0m %s\n' "$*"; }

# ----------------------------------------------------------------------------
# GPU detection
# ----------------------------------------------------------------------------
GPU_NAME="cpu"
GPU_BACKEND="cpu"
GPU_CC=""
VRAM_TOTAL_GB=0
VRAM_USABLE_GB=0
LEGACY_CUDA=false
CONTAINER_GPU=false
NOTES=()

if command -v nvidia-smi >/dev/null 2>&1; then
  GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -n1)
  GPU_BACKEND="cuda"

  MEM_KB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -n1)
  VRAM_TOTAL_GB=$(awk -v kb="$MEM_KB" 'BEGIN { printf "%.1f", kb / 1048576 }')
  VRAM_USABLE_GB=$(awk -v t="$VRAM_TOTAL_GB" 'BEGIN { v = t - 1; printf "%.1f", v > 0 ? v : 0 }')

  CC_OUTPUT=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -n1 || true)
  if [[ "$CC_OUTPUT" =~ ^[0-9]+\.[0-9]+$ ]]; then
    GPU_CC="$CC_OUTPUT"
  fi

  # CUDA 13 dropped pre-Turing architectures (e.g. Pascal, cc 6.x). llama.cpp
  # built against CUDA 13 will silently fall back to the CPU on such cards.
  # The Docker image ships both cuda_v12 and cuda_v13 runtimes, so it handles
  # this itself -- distro builds do not. Flag it so the GUI can warn the user.
  if [[ -n "$GPU_CC" ]]; then
    MAJOR="${GPU_CC%%.*}"
    if (( MAJOR < 7 )); then
      LEGACY_CUDA=true
      NOTES+=("GPU is pre-Turing (compute capability $GPU_CC). Use the Docker image, not a distro llama.cpp built against CUDA 13, or it will silently run on CPU. ggml-vulkan also works.")
    fi
  fi

  if command -v nvidia-ctk >/dev/null 2>&1 || docker info 2>/dev/null | grep -qi nvidia; then
    CONTAINER_GPU=true
  else
    NOTES+=("The GPU is present but not available to Docker. Install nvidia-container-toolkit, then: sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker")
  fi
else
  NOTES+=("No NVIDIA GPU detected. Models will run on the CPU.")
fi

if [[ "$CONTAINER_GPU" == false && "$GPU_BACKEND" == "cuda" ]]; then
  VRAM_USABLE_GB=0
  GPU_BACKEND="cpu"
fi

# ----------------------------------------------------------------------------
# RAM
# ----------------------------------------------------------------------------
RAM_TOTAL_GB=$(awk '/MemTotal/ { printf "%.1f", $2 / 1048576 }' /proc/meminfo)
RAM_USABLE_GB=$(awk -v t="$RAM_TOTAL_GB" 'BEGIN { v = t - 6; printf "%.1f", v > 0 ? v : 0 }')

# ----------------------------------------------------------------------------
# Tuning -> llama-server flags
# ----------------------------------------------------------------------------
TARGET_CONTEXT=8192
KV_TYPE="q8_0"
FLASH_ATTN=1

if [[ "$GPU_BACKEND" == "cuda" ]]; then
  if (( $(awk -v v="$VRAM_USABLE_GB" 'BEGIN { print (v < 6) }') )); then
    TARGET_CONTEXT=4096
  elif (( $(awk -v v="$VRAM_USABLE_GB" 'BEGIN { print (v >= 16) }') )); then
    TARGET_CONTEXT=32768
  else
    TARGET_CONTEXT=16384
  fi
else
  # CPU: 8k is a sane default; larger KV on CPU hurts prompt processing badly.
  TARGET_CONTEXT=8192
  KV_TYPE="f16"
  NOTES+=("Running on CPU. Context is capped at 8k for speed.")
fi

# -1 keeps every layer on the GPU; 0 keeps every layer on the CPU.
N_GPU_LAYERS=-1
[[ "$GPU_BACKEND" != "cuda" ]] && N_GPU_LAYERS=0

# ----------------------------------------------------------------------------
# Write hardware.json
# ----------------------------------------------------------------------------
mkdir -p "$(dirname "$HW_FILE")"
{
  echo "{"
  echo "  \"generated\": \"$(date -Iseconds)\"," 
  echo "  \"detected\": true,"
  echo "  \"gpu\": {"
  echo "    \"name\": \"$GPU_NAME\"," 
  if [[ -n "$GPU_CC" ]]; then echo "    \"computeCapability\": $GPU_CC,"; fi
  echo "    \"vramTotalGB\": $VRAM_TOTAL_GB," 
  echo "    \"vramUsableGB\": $VRAM_USABLE_GB," 
  echo "    \"backend\": \"$GPU_BACKEND\"," 
  echo "    \"legacyCuda\": $LEGACY_CUDA"
  echo "  },"
  echo "  \"ram\": { \"totalGB\": $RAM_TOTAL_GB, \"usableGB\": $RAM_USABLE_GB },"
  echo "  \"targetContext\": $TARGET_CONTEXT," 
  echo "  \"kvCacheType\": \"$KV_TYPE\"," 
  echo "  \"flashAttention\": true," 
  echo "  \"containerGpu\": $CONTAINER_GPU," 
  echo "  \"notes\": ["
  for i in "${!NOTES[@]}"; do
    n="${NOTES[$i]}"
    comma=","; [[ $i -eq $((${#NOTES[@]} - 1)) ]] && comma=""
    printf '    "%s"%s\n' "${n//\"/\\\"}" "$comma"
  done
  echo "  ]"
  echo "}"
} > "$HW_FILE"

log "wrote $HW_FILE"

# ----------------------------------------------------------------------------
# Rewrite the tuning block in .env
# ----------------------------------------------------------------------------
if [[ ! -f "$ENV_FILE" ]]; then
  cp "$ROOT/.env.example" "$ENV_FILE"
  log "created .env from .env.example"
fi

write_env() {
  local key="$1" val="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
  else
    echo "${key}=${val}" >> "$ENV_FILE"
  fi
}

write_env LLAMA_CTX_SIZE "$TARGET_CONTEXT"
write_env LLAMA_CACHE_TYPE_K "$KV_TYPE"
write_env LLAMA_FLASH_ATTN "$FLASH_ATTN"
write_env LLAMA_N_GPU_LAYERS "$N_GPU_LAYERS"

log "updated .env: ctx=$TARGET_CONTEXT kv=$KV_TYPE flash_attn=$FLASH_ATTN ngl=$N_GPU_LAYERS"
