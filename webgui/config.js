// Runtime configuration for the LLM Hub web GUI.
// Edit this file, then just reload the page -- no rebuild needed.
window.LLM_HUB = {
  // Model server endpoint. "/ollama" is reverse-proxied to the ollama service
  // by nginx.conf, so requests are same-origin and progress streams unbuffered.
  //
  // To drive a different machine instead, use its direct URL, e.g.
  //   ollama: "http://192.168.1.50:11434"
  // and make sure that server allows this page's origin via OLLAMA_ORIGINS.
  ollama: "/ollama",

  // Port the Ollama API is published on. Used only to display the endpoint
  // URLs in the Library; the GUI itself always talks through `ollama` above.
  // Keep in step with OLLAMA_PORT in .env.
  ollamaPort: 11435,

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
