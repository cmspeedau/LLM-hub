#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# autotune.sh -- probe this machine and publish a hardware profile.
#
#   scripts/autotune.sh           write webgui/hardware.json, print a summary
#   scripts/autotune.sh --apply   also rewrite the managed block in .env
#   scripts/autotune.sh --print   print the summary, write nothing
#
# This is what makes "Best for this device" mean something. The GUI reads
# webgui/hardware.json and judges every model against it, so the profile has
# to describe the machine the models will actually run on.
#
# It runs on the HOST rather than in a container: the web GUI container is
# plain nginx with no nvidia-smi, and the point is to profile the host GPU.
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
HW_JSON="$ROOT/webgui/hardware.json"
ENV_FILE="$ROOT/.env"
MODE="write"

for arg in "$@"; do
  case "$arg" in
    --apply) MODE="apply" ;;
    --print) MODE="print" ;;
    -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown option: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

# MiB -> GiB, one decimal. GPU sizes are quoted in GiB, so this matches what
# the owner of an "11 GB" card expects to see.
gib_mib() { awk -v k="$1" 'BEGIN{printf "%.1f", k/1024}'; }
# kB -> GiB, for /proc/meminfo fields.
gib_kb()  { awk -v k="$1" 'BEGIN{printf "%.1f", k/1048576}'; }

# --------------------------------------------------------------- GPU ------

GPU_NAME=""; VRAM_MIB=""; CC=""
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
  line="$(nvidia-smi --query-gpu=name,memory.total,compute_cap \
            --format=csv,noheader,nounits 2>/dev/null | head -n1)"
  if [[ -n "$line" ]]; then
    GPU_NAME="$(printf '%s' "$line" | cut -d, -f1 | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    VRAM_MIB="$(printf '%s' "$line" | cut -d, -f2 | tr -d ' ')"
    CC="$(printf '%s' "$line"          | cut -d, -f3 | tr -d ' ')"
  fi
fi

# Which backend can run on this card?
#
# Ollama ships two CUDA builds and picks one by architecture: cuda_v13 covers
# 7.5 and up, cuda_v12 covers 5.0 through 12.0. Anything below 5.0 has no
# build at all. Getting this wrong is the classic silent-CPU-fallback trap:
# a distro ggml-cuda built against CUDA 13 will compile/run fine and then
# quietly leave the GPU idle on a Pascal card.
BACKEND="cpu"; LEGACY="false"
if [[ -n "$CC" ]]; then
  if awk -v cc="$CC" 'BEGIN{exit !(cc >= 5.0)}'; then
    BACKEND="cuda"
    awk -v cc="$CC" 'BEGIN{exit !(cc < 7.5)}' && LEGACY="true"
  fi
fi

if [[ -n "$VRAM_MIB" && "$VRAM_MIB" =~ ^[0-9]+$ && "$VRAM_MIB" -gt 0 ]]; then
  VRAM_TOTAL_GB="$(gib_mib "$VRAM_MIB")"
else
  VRAM_TOTAL_GB="0.0"
fi

# Reserve 1 GiB for the desktop compositor and the driver's own allocations.
# Overshooting here only costs a smaller context; undershooting costs an OOM
# or an invisible spill onto the CPU.
VRAM_USABLE_GB="$(awk -v t="$VRAM_TOTAL_GB" 'BEGIN{u=t-1.0; if(u<0)u=0; printf "%.1f", u}')"

# --------------------------------------------------------------- RAM ------

RAM_TOTAL_GB="$(gib_kb "$(awk '/^MemTotal:/{print $2}' /proc/meminfo)")"
# Leave room for the OS, the browser and the containers. A model that only
# fits by evicting everything else will thrash rather than run.
RAM_USABLE_GB="$(awk -v t="$RAM_TOTAL_GB" 'BEGIN{u=t-6; if(u<t*0.4)u=t*0.4; if(u<0)u=0; printf "%.1f", u}')"

# --------------------------------------------------------- context -------

CTX=4096; KV="f16"; FA="0"
if [[ "$BACKEND" != "cpu" ]]; then
  # A quantised KV cache halves memory but only works with flash attention on.
  KV="q8_0"; FA="1"
  CTX="$(awk -v v="$VRAM_USABLE_GB" 'BEGIN{
    if (v >= 20) print 32768; else if (v >= 10) print 16384;
    else if (v >= 6) print 8192; else print 4096 }')"
fi

# --------------------------------------------- container GPU access ------

CONTAINER_GPU="false"
if command -v docker >/dev/null 2>&1; then
  if docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q nvidia; then
    CONTAINER_GPU="true"
  fi
fi

# --------------------------------------------------------------- notes ----

NOTES=()
[[ "$LEGACY" == "true" ]] && NOTES+=(
  "Compute capability $CC predates Turing. Ollama must use its CUDA 12 bundle here; CUDA 13 dropped this architecture, which is why a distro ggml-cuda package silently falls back to the CPU on this card.")
[[ "$BACKEND" == "cpu" ]] && NOTES+=(
  "No usable NVIDIA GPU found, so every model will run on the CPU. Expect roughly a sixth of the GPU's token rate.")
[[ "$BACKEND" != "cpu" && "$CONTAINER_GPU" != "true" ]] && NOTES+=(
  "The GPU is present but not available to Docker yet: install nvidia-container-toolkit and run 'make up-gpu', otherwise the container runs on CPU.")

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

# Join the notes with commas *between* them -- a trailing comma would make the
# whole profile unparseable in the browser.
notes_json=""
for n in ${NOTES[@]+"${NOTES[@]}"}; do
  [[ -z "$n" ]] && continue
  [[ -n "$notes_json" ]] && notes_json+=","$'\n'
  notes_json+="    \"$(json_escape "$n")\""
done
[[ -n "$notes_json" ]] && notes_json+=$'\n'

# --------------------------------------------------------------- write ----

write_json() {
  cat > "$HW_JSON" <<EOF
{
  "detected": true,
  "generated": "$(date -Iseconds)",
  "host": "$(json_escape "$(uname -sr)")",
  "gpu": {
    "name": "$(json_escape "${GPU_NAME:-none}")",
    "computeCapability": $( [[ -n "$CC" ]] && printf '%s' "$CC" || printf 'null' ),
    "vramTotalGB": $VRAM_TOTAL_GB,
    "vramUsableGB": $VRAM_USABLE_GB,
    "backend": "$BACKEND",
    "legacyCuda": $LEGACY
  },
  "ram": {
    "totalGB": $RAM_TOTAL_GB,
    "usableGB": $RAM_USABLE_GB
  },
  "targetContext": $CTX,
  "kvCacheType": "$KV",
  "flashAttention": $([[ "$FA" == "1" ]] && echo true || echo false),
  "containerGpu": $CONTAINER_GPU,
  "notes": [
$notes_json  ]
}
EOF
}

apply_env() {
  local block
  block="$(mktemp)"
  cat > "$block" <<EOF
# >>> autotune >>>
OLLAMA_CONTEXT_LENGTH=$CTX
OLLAMA_KV_CACHE_TYPE=$KV
OLLAMA_FLASH_ATTENTION=$FA
OLLAMA_NUM_PARALLEL=1
OLLAMA_MAX_LOADED_MODELS=1
# <<< autotune <<<
EOF

  if [[ ! -f "$ENV_FILE" ]]; then
    cp -- "$block" "$ENV_FILE"
  elif grep -q '# >>> autotune >>>' "$ENV_FILE"; then
    awk -v blk="$block" '
      /# >>> autotune >>>/ {
        while ((getline l < blk) > 0) print l
        close(blk); skip = 1; next
      }
      /# <<< autotune <<</ { skip = 0; next }
      !skip { print }
    ' "$ENV_FILE" > "$ENV_FILE.tmp"
    mv -- "$ENV_FILE.tmp" "$ENV_FILE"
  else
    printf '\n' >> "$ENV_FILE"
    cat -- "$block" >> "$ENV_FILE"
  fi
  rm -f -- "$block"
}

# --------------------------------------------------------------- report ---

printf '\n  LLM Hub autotune\n'
printf '  %s\n' "-------------------------------------------------------"
printf '  %-16s %s\n' 'GPU'      "${GPU_NAME:-none detected}"
printf '  %-16s %s\n' 'Compute'  "${CC:-n/a}"
printf '  %-16s %s GiB usable of %s GiB\n' 'VRAM' "$VRAM_USABLE_GB" "$VRAM_TOTAL_GB"
printf '  %-16s %s GiB usable of %s GiB\n' 'RAM' "$RAM_USABLE_GB" "$RAM_TOTAL_GB"
printf '  %-16s %s\n' 'Backend'  "$BACKEND$([[ "$LEGACY" == true ]] && printf ' (CUDA 12 bundle required)')"
printf '  %-16s %s%s\n' 'Context' "$CTX" "$([[ "$KV" != f16 ]] && printf ' (KV %s, flash attention on)' "$KV")"
printf '  %-16s %s\n' 'Docker GPU' "$CONTAINER_GPU"
printf '  %s\n' "-------------------------------------------------------"
for n in "${NOTES[@]:-}"; do [[ -n "$n" ]] && printf '  ! %s\n\n' "$n"; done

case "$MODE" in
  print) printf '  (print only: nothing written)\n\n' ;;
  apply) write_json; apply_env
         printf '  wrote %s\n  updated the autotune block in %s\n\n' \
           "${HW_JSON#"$ROOT"/}" "${ENV_FILE#"$ROOT"/}" ;;
  *)     write_json
         printf '  wrote %s\n\n' "${HW_JSON#"$ROOT"/}" ;;
esac
