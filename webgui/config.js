// Runtime configuration for the LLM Hub web GUI.
// Edit this file, then just reload the page -- no rebuild needed.
window.LLM_HUB = {
  // Engine (llama.cpp server, OpenAI-compatible API), reverse-proxied by nginx
  // so requests are same-origin. To reach another machine directly, use e.g.
  //   llama: "http://192.168.1.50:8081"
  llama: "/llama",

  // Runner: downloads GGUF files from Hugging Face and manages /models.
  runner: "/downloader",

  // Port the engine's OpenAI API is published on. Used only to display the
  // endpoint URLs in the Library; the GUI itself always talks through `llama`.
  // Keep in step with LLAMA_PORT in .env.
  llamaPort: 8081,

  // Public Hugging Face API (CORS enabled, no token needed for public repos).
  hf: "https://huggingface.co",

  // Number of models fetched per search.
  pageSize: 25,

  // Label shown in the "Download to" control.
  targetLabel: "This device",

  // VRAM budget in GB (decimal). Drives the fits / partial-offload hint.
  vramGB: 11,

  // "Staff picks" toggle keeps only these curated GGUF publishers.
  trustedPublishers: [
    "unsloth", "bartowski", "lmstudio-community", "ggml-org",
    "Qwen", "google", "meta-llama", "microsoft", "mistralai",
    "nvidia", "LiquidAI", "deepseek-ai", "TheBloke",
  ],
};
