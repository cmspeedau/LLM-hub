# LLM Hub

A Hugging Face style model browser that runs in Docker, pulls GGUF models
through [Ollama](https://ollama.com), and serves them over the Ollama and
OpenAI HTTP APIs.

The GUI does two things and no more: **download models** and **serve models**.
There is no chat client — point your own tool at the endpoint when you are
done. The one thing it does that a plain model list does not is tell you, up
front, **which models will actually run well on this machine** and at which
quantisation.

<!-- -->
    make up          # CPU
    make up-gpu      # with the GPU (needs nvidia-container-toolkit)
    open http://localhost:8080

---

## What you need

| | |
|---|---|
| Docker | with the Compose plugin |
| Ollama engine | pulled automatically (`ollama/ollama:latest`) |
| NVIDIA GPU | optional, but roughly 6× faster. Needs the NVIDIA Container Toolkit |
| Hugging Face account | not needed — public repos work without a token |

Disk: GGUF models are large. A 7B Q4_K_M is about 4.7 GB, a 27B about 17.7 GB.

---

## Quick start

```bash
cd llm-hub
make up                      # profiles the host, then starts the stack
make logs                    # follow the model server
```

Then open **http://localhost:8080**, search for a model, pick a quantisation
and hit Download. It lands in the `llm-hub-models` Docker volume and can be
loaded into memory from the Library tab.

To use the GPU instead of the CPU:

```bash
sudo pacman -S nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
make up-gpu
make gpu-check               # should print your card
```

Nothing else needs configuring. `make up` runs the hardware probe first, so
the fit badges always describe the machine you are on.

---

## The hardware profile

`scripts/autotune.sh` probes the host and writes `webgui/hardware.json`, which
the GUI reads to decide what "fits" means:

```json
{
  "gpu": { "name": "NVIDIA GeForce GTX 1080 Ti", "computeCapability": 6.1,
           "vramTotalGB": 11.0, "vramUsableGB": 10.0,
           "backend": "cuda", "legacyCuda": true },
  "ram": { "totalGB": 14.9, "usableGB": 8.9 },
  "targetContext": 16384,
  "kvCacheType": "q8_0",
  "flashAttention": true,
  "containerGpu": false,
  "notes": [ "…" ]
}
```

`make autotune` also rewrites the tuning block in `.env` — context length, KV
cache type, flash attention — sized to the detected GPU. Those become
`OLLAMA_*` environment variables on the model server. Changing them needs
`make restart` to take effect.

The profile is deliberately conservative. VRAM reserves 1 GiB for the desktop
compositor, RAM reserves 6 GiB for the OS and browser. Overshooting the budget
costs a smaller context; undershooting costs an OOM kill or a model that
quietly spills onto the CPU and runs at a sixth of the speed.

If the GUI has no profile it falls back to safe defaults and says so, rather
than guessing.

---

## How "Best for this device" works

Every model is scored with one shared `fit()` function, which answers a single
question: given the weights, the KV cache at the target context, and the
compute overhead, does this fit in VRAM?

| Badge | Meaning |
|---|---|
| **Runs on GPU** | Weights and full context fit in VRAM — the good case |
| **Runs at Nk ctx** | Weights fit, the KV cache does not; context is reduced |
| **Partial offload** | Some layers stay on the CPU; slower, but it runs |
| **CPU only** | No usable GPU; works if it fits in RAM |
| **Too large** | Exceeds GPU and CPU memory |

The same function picks the default quantisation (the best quality that still
fits), so the ranking, the row badge and the recommendation on the detail page
can never contradict each other.

Sizes come from real GGUF file listings where available, and from a calibrated
parameter-count estimate (about 0.66 GB per billion parameters at Q4_K_M)
before the file list loads. Estimated badges say so.

---

## Connecting a client

Both APIs are served by the same container:

```
Ollama API   http://localhost:11435
OpenAI API   http://localhost:11435/v1
```

```bash
# Ollama clients
ollama --host http://localhost:11435 run hf.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M

# Any OpenAI-compatible client
curl http://localhost:11435/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"hf.co/bartowski/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M",
       "messages":[{"role":"user","content":"hello"}]}'
```

Ports live in `.env` (`WEBGUI_PORT`, `OLLAMA_PORT`).

---

## Layout

```
docker-compose.yml        model server + web GUI
docker-compose.gpu.yml    GPU passthrough overlay
.env                      ports and model-server tuning
Makefile                  up / down / logs / autotune / gpu-check / models
nginx.conf                serves the GUI, proxies /ollama/ to the server
scripts/autotune.sh       probes the host, writes the profile
webgui/index.html         GUI shell
webgui/app.js             search, fit ranking, download, library
webgui/styles.css         dark theme
webgui/config.js          runtime config (endpoint, VRAM, publishers)
webgui/hardware.json      generated profile — do not edit by hand
```

---

## Troubleshooting

**Models run far slower than they should.** The GPU is not in use. Check for a
warning on the Library tab, then:

```bash
make gpu-check      # can the container see the card?
docker exec llm-hub-ollama ollama ps   # is the model 100% GPU?
```

**An old card silently falls back to the CPU.** CUDA 13 dropped pre-Turing
architectures, including Pascal (compute capability 6.1 on the GTX 1080 Ti).
Ollama ships two CUDA builds and picks one by architecture — `cuda_v13` for 7.5
and up, `cuda_v12` for 5.0 and up — so Ollama itself is fine on Pascal and
selects `cuda_v12` automatically. The trap is *distro* packages: a `ggml-cuda`
built against CUDA 13 has no kernels for this card and falls back to the CPU
without an error. If you want a distro llama.cpp alongside this stack, use
`ggml-vulkan` instead. `hardware.json` records `legacyCuda` so the GUI can warn
you.

**Context length is tiny, or a model spills onto the CPU.** Everything competes
for the same VRAM. Lower `OLLAMA_CONTEXT_LENGTH`, or set
`OLLAMA_MAX_LOADED_MODELS=1`. Both are managed by `make autotune`; run
`make restart` afterwards.

**Port 11435 already in use.** A native Ollama usually owns 11434. Change
`OLLAMA_PORT` in `.env`. Note that if a native Ollama is running it owns the
GPU too, and both processes contend for the same 11 GB of VRAM — stop one.

**Downloads stall or the progress bar freezes.** The nginx proxy disables
buffering for `/ollama/` precisely so pull progress streams; if you changed
`nginx.conf`, keep `proxy_buffering off`.

**`make autotune` reports "The GPU is present but not available to Docker".**
Expected until the NVIDIA Container Toolkit is installed. The stack still works
on the CPU meanwhile.
