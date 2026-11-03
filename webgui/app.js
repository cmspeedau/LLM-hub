'use strict';

/* ===========================================================================
   LLM Hub — web GUI
   ---------------------------------------------------------------------------
   A Hugging Face style model browser that downloads raw GGUF files through the
   runner sidecar and serves them with the llama.cpp server (LM Studio model).

   Two ideas keep this honest:

     1. One hardware profile drives everything. `scripts/autotune.sh` probes
        the host and writes `hardware.json`, served statically next to this
        file. If it is missing we fall back to conservative defaults rather
        than pretending we know the machine.

     2. One fit function drives everything. `fit()` answers "does this model
        actually work here", and it is reused by the row badge, the default
        quant choice and the detail panel. If the three ever disagree the user
        stops believing any of them.
   =========================================================================== */

const CFG = Object.assign({
  llama: '/llama',       // llama.cpp server (OpenAI-compatible API)
  runner: '/downloader', // downloader / model manager sidecar
  llamaPort: 8081,
  hf: 'https://huggingface.co',
  pageSize: 25,
  targetLabel: 'This device',
  vramGB: 11,
  trustedPublishers: [],
}, window.LLM_HUB || {});

/* --------------------------------------------------------------- helpers */

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function fmtBytes(bytes, digits = 1) {
  if (!bytes || bytes < 0) return '--';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, n = bytes;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return `${n.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

const fmtNum = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '--');

function fromNow(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!then) return '';
  const secs = Math.max(0, (Date.now() - then) / 1000);
  const steps = [
    [60, 'second'], [60, 'minute'], [24, 'hour'],
    [30, 'day'], [12, 'month'], [Infinity, 'year'],
  ];
  let v = secs, unit = 'second';
  for (const [size, name] of steps) {
    if (v < size) { unit = name; break; }
    v /= size;
    unit = name;
  }
  const n = Math.max(1, Math.floor(v));
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
}

function safeUrl(u) {
  try {
    const url = new URL(u, location.href);
    return (url.protocol === 'http:' || url.protocol === 'https:') ? url.href : '#';
  } catch { return '#'; }
}

/** Run async tasks with a concurrency cap, so 25 rows do not fire 75 requests. */
function makeQueue(limit) {
  let active = 0;
  const queue = [];
  const pump = () => {
    if (active >= limit || !queue.length) return;
    active += 1;
    const job = queue.shift();
    job.fn().then(job.resolve, job.reject).finally(() => { active -= 1; pump(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
}
const hfQueue = makeQueue(3);

/* ----------------------------------------------------------------- icons */

const ICON = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-6M22 20H2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  download: '<path d="M12 3v12M7 11l5 5 5-5M4 20h16"/>',
  external: '<path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  gpu: '<rect x="3" y="7" width="15" height="10" rx="2"/><path d="M18 10h3v4h-3M7 11v2M11 11v2M15 11v2"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>',
  trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>',
  play: '<path d="M7 4l12 8-12 8z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2 5.7M20 5v6h-6"/>',
};

const svg = (path, cls = 'ic') => `<svg viewBox="0 0 24 24" class="${cls}" aria-hidden="true">${path}</svg>`;

/* ==================================================================== */
/*  Hardware profile                                                     */
/* ==================================================================== */

const DEFAULT_HW = {
  detected: false,
  gpu: { name: 'unknown', computeCapability: null, vramTotalGB: CFG.vramGB, vramUsableGB: CFG.vramGB - 1, backend: 'cpu' },
  ram: { totalGB: 14, usableGB: 6 },
  targetContext: 16384,
  kvCacheType: 'q8_0',
  flashAttention: true,
};

const state = {
  view: 'discover',
  sort: 'best',
  query: '',
  staffPicks: false,
  models: [],
  selectedId: null,
  detail: null,
  quant: null,
  local: [],          // [{ file, size, mtime }] from the runner
  active: null,       // currently loaded GGUF file name
  engineUp: false,    // llama.cpp server reachable
  runnerUp: false,    // runner sidecar reachable
  runnerErr: null,
  offline: false,
  loading: true,
  pulls: new Map(),   // `${repo}:${quant}` -> progress
  hw: DEFAULT_HW,
};

async function loadHardware() {
  try {
    const r = await fetch('hardware.json', { cache: 'no-store' });
    if (r.ok) {
      const hw = await r.json();
      state.hw = Object.assign({}, DEFAULT_HW, hw, {
        gpu: Object.assign({}, DEFAULT_HW.gpu, hw.gpu || {}),
        ram: Object.assign({}, DEFAULT_HW.ram, hw.ram || {}),
      });
    }
  } catch { /* keep the conservative default */ }
}

/* ==================================================================== */
/*  Fit — the single source of truth for "will this work here"           */
/* ==================================================================== */

/* Decimal GB per billion parameters, calibrated against real GGUF files:
   a 7B Q4_K_M is 4.68 GB (0.66 GB/B), a 27B Q4_K_M is 17.74 GB (0.657). */
const GB_PER_B = {
  IQ2_M: 0.40, Q2_K: 0.43, IQ3_XS: 0.48, Q3_K_S: 0.50, IQ3_M: 0.52,
  MXFP4: 0.53, Q3_K_M: 0.54, Q3_K_L: 0.57, Q4_0: 0.59, IQ4_XS: 0.60,
  Q4_K_S: 0.62, Q4_K_M: 0.66, Q5_K_S: 0.74, Q5_K_M: 0.78, Q6_K: 0.89,
  Q8_0: 1.16, F16: 2.0, BF16: 2.0, F32: 4.0,
};

/* Quality preference when several quants fit. */
const QUANT_ORDER = [
  'Q4_K_M', 'Q5_K_M', 'Q4_K_S', 'IQ4_XS', 'Q4_0', 'Q6_K', 'Q5_K_S',
  'IQ3_M', 'Q3_K_M', 'Q3_K_S', 'Q2_K', 'Q8_0', 'MXFP4', 'F16',
];

const quantRank = (q) => {
  const i = QUANT_ORDER.indexOf(q);
  return i === -1 ? QUANT_ORDER.length + 1 : i;
};

/** Conservative f16 KV cost. Replace with real GGUF header values when wired. */
const KV_BYTES_PER_TOKEN_PER_B = 12000;

function kvGB(paramsBillion, ctx, kvType) {
  const perToken = paramsBillion * KV_BYTES_PER_TOKEN_PER_B * (kvType === 'q8_0' ? 0.5 : 1);
  return (perToken * ctx) / 1e9;
}

/** Pull a parameter count out of a repo name: "Qwen3.6-35B-A3B" -> 35. */
function paramsFromName(id) {
  const name = String(id).split('/').pop() || String(id);
  let best = 0;
  for (const m of name.matchAll(/(\d+(?:\.\d+)?)\s*[bB](?![a-zA-Z])/g)) {
    const v = parseFloat(m[1]);
    if (Number.isFinite(v) && v > best) best = v;
  }
  return best || null;
}

const COMPUTE_OVERHEAD_GB = 0.7;

/**
 * The one place that decides whether a model works here.
 * `sizeGB` may be exact (from HF file sizes) or estimated from the name.
 */
function fit({ sizeGB, paramsB, quant, hw = state.hw }) {
  const vram = Number(hw.gpu.vramUsableGB) || 0;
  const ram = Number(hw.ram.usableGB) || 0;
  const onGpu = hw.gpu.backend !== 'cpu' && vram > 0;
  const ctx = Number(hw.targetContext) || 16384;
  const kv = kvGB(paramsB || 0, ctx, hw.kvCacheType);

  if (!sizeGB) {
    return { verdict: 'unknown', label: 'Unknown size', cls: 'v-unknown', maxContext: null, reason: 'no size information' };
  }

  if (!onGpu) {
    const need = sizeGB + kv + 1.0;
    if (need <= ram) {
      return { verdict: 'cpu-ok', label: 'CPU only', cls: 'v-cpu', maxContext: ctx, reason: 'no GPU available' };
    }
    return { verdict: 'too-large', label: 'Too large', cls: 'v-bad', maxContext: null, reason: 'exceeds CPU memory' };
  }

  const need = sizeGB + kv + COMPUTE_OVERHEAD_GB;
  if (need <= vram) {
    return { verdict: 'vram', label: 'Runs on GPU', cls: 'v-good', maxContext: ctx, reason: `fits ${vram.toFixed(0)} GB with ${Math.round(ctx / 1024)}k context` };
  }

  // Weights fit, the KV cache does not. How much context can we keep?
  if (sizeGB + COMPUTE_OVERHEAD_GB < vram) {
    const room = vram - sizeGB - COMPUTE_OVERHEAD_GB;
    const perToken = (paramsB || 0) * KV_BYTES_PER_TOKEN_PER_B * (hw.kvCacheType === 'q8_0' ? 0.5 : 1);
    const maxCtx = perToken > 0 ? Math.floor((room * 1e9) / perToken / 1024) * 1024 : 0;
    if (maxCtx >= 2048) {
      return { verdict: 'reduced-ctx', label: `Runs at ${Math.round(maxCtx / 1024)}k ctx`, cls: 'v-warn', maxContext: maxCtx, reason: 'fits only with a smaller context' };
    }
  }

  if (need <= vram + ram) {
    return { verdict: 'partial', label: 'Partial offload', cls: 'v-warn', maxContext: ctx, reason: 'some layers stay on CPU' };
  }

  return { verdict: 'too-large', label: 'Too large', cls: 'v-bad', maxContext: null, reason: 'exceeds GPU and CPU memory' };
}

/** Fit a whole model, choosing the best quant whose weights fit. */
function fitModel(id, { paramsB, sizes, hw = state.hw }) {
  const ppB = paramsB || paramsFromName(id) || 0;
  const quants = sizes
    ? Object.entries(sizes).map(([q, bytes]) => ({ quant: q, sizeGB: bytes / 1e9, exact: true }))
    : QUANT_ORDER.map((q) => ({ quant: q, sizeGB: ppB * (GB_PER_B[q] ?? 0.66), exact: false }));

  const scored = quants.map((q) => ({ ...q, fit: fit({ sizeGB: q.sizeGB, paramsB: ppB, quant: q.quant, hw }) }));

  // Prefer the highest-quality quant that runs fully on the GPU.
  const ranked = scored.slice().sort((a, b) => {
    const av = a.fit.verdict === 'vram' ? 0 : 1;
    const bv = b.fit.verdict === 'vram' ? 0 : 1;
    if (av !== bv) return av - bv;
    if (quantRank(a.quant) !== quantRank(b.quant)) return quantRank(a.quant) - quantRank(b.quant);
    return b.sizeGB - a.sizeGB;
  });

  const best = ranked[0];
  const fallback = scored.slice().sort((a, b) => b.sizeGB - a.sizeGB)
    .find((s) => s.fit.verdict === 'vram' || s.fit.verdict === 'reduced-ctx' || s.fit.verdict === 'partial');

  return {
    paramsB: ppB,
    quants: scored,
    recommended: best ? best.quant : null,
    overall: (fallback || best || { fit: fit({ sizeGB: 0 }) }).fit,
    exact: Boolean(sizes),
  };
}

/** Rank Discover results: what works here first, then what is bigger and better. */
function fitScore(model) {
  const fm = model._fit;
  if (!fm) return -1e9;
  const v = fm.overall.verdict;
  let score = { vram: 5000, 'reduced-ctx': 1200, partial: 250, 'cpu-ok': 120, 'too-large': -900 }[v] ?? -900;
  if (v === 'vram') score += clamp(fm.paramsB || 0, 0, 40) * 30;   // bigger is better, if it fits
  score += Math.log10(1 + (model.downloads || 0)) * 12;
  score += Math.min(model.likes || 0, 1000) / 40;
  return score;
}

/* ==================================================================== */
/*  Hugging Face API                                                     */
/* ==================================================================== */

const readmeCache = new Map();
const avatarCache = new Map();
const detailCache = new Map();

const HF_SORTS = {
  best: { sort: 'trendingScore', direction: -1 },
  recommended: { sort: 'trendingScore', direction: -1 },
  downloads: { sort: 'downloads', direction: -1 },
  likes: { sort: 'likes', direction: -1 },
  recent: { sort: 'lastModified', direction: -1 },
};

const SORT_LABELS = {
  best: 'Best for this device',
  recommended: 'Recommended',
  downloads: 'Most downloads',
  likes: 'Most likes',
  recent: 'Recently updated',
};

async function hfSearch() {
  const params = new URLSearchParams({
    filter: 'gguf',
    limit: String(state.sort === 'best' ? CFG.pageSize * 3 : CFG.pageSize),
    ...HF_SORTS[state.sort],
  });
  if (state.query) params.set('search', state.query);
  if (state.staffPicks) {
    const pubs = CFG.trustedPublishers.length ? CFG.trustedPublishers : ['unsloth', 'bartowski'];
    pubs.forEach((p) => params.append('author', p));
  }
  const r = await fetch(`${CFG.hf}/api/models?${params}`, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Hugging Face returned ${r.status}`);
  return r.json();
}

async function hfDetail(id) {
  if (detailCache.has(id)) return detailCache.get(id);
  const p = (async () => {
    const r = await fetch(`${CFG.hf}/api/models/${id}?blobs=true`);
    if (!r.ok) throw new Error(`Hugging Face returned ${r.status}`);
    return r.json();
  })();
  detailCache.set(id, p);
  return p;
}

async function hfReadme(id) {
  if (readmeCache.has(id)) return readmeCache.get(id);
  const p = (async () => {
    try {
      const r = await fetch(`${CFG.hf}/${id}/raw/main/README.md`);
      return r.ok ? r.text() : '';
    } catch { return ''; }
  })();
  readmeCache.set(id, p);
  return p;
}

async function hfAvatar(id) {
  const org = String(id).split('/')[0];
  if (!org) return null;
  if (avatarCache.has(org)) return avatarCache.get(org);
  const p = hfQueue(async () => {
    for (const path of [`/api/organizations/${org}/avatar`, `/api/users/${org}/avatar`]) {
      try {
        const r = await fetch(CFG.hf + path);
        if (r.ok) {
          const j = await r.json();
          if (j && j.avatarUrl) return j.avatarUrl;
        }
      } catch { /* try the next endpoint */ }
    }
    return null;
  });
  avatarCache.set(org, p);
  return p;
}

/* ------------------------------------------------------ GGUF file parsing */

const QUANT_RE = /(IQ\d+_[A-Z0-9]+|Q\d+_K(?:_[A-Z]+)?|Q\d+_\d|MXFP4|BF16|FP?16|F32|TQ\d_\d)$/i;
const MULTIPART_RE = /-(\d{5})-of-(\d{5})$/i;

/** Turn sibling filenames into { quant -> bytes }, merging multi-part files. */
function parseGgufFiles(siblings) {
  const sizes = {};
  const meta = {};
  for (const s of siblings || []) {
    const file = s.rfilename || '';
    if (!file.toLowerCase().endsWith('.gguf')) continue;
    let base = file.replace(/\.gguf$/i, '');
    let parts = 1;
    const mp = base.match(MULTIPART_RE);
    if (mp) { parts = Number(mp[2]) || 1; base = base.slice(0, mp.index); }
    const m = base.match(QUANT_RE);
    const quant = m ? m[1].toUpperCase() : null;
    if (!quant) continue;
    const bytes = Number(s.size || 0);
    sizes[quant] = (sizes[quant] || 0) + bytes;
    meta[quant] = { parts, file };
  }
  return { sizes, meta };
}

function humanParams(n) {
  if (!n) return null;
  const b = n / 1e9;
  if (b >= 1) return `${(Math.round(b * 10) / 10).toFixed(b < 10 ? 1 : 0).replace(/\.0$/, '')}B`;
  return `${Math.round(n / 1e6)}M`;
}

function capabilitiesOf(model, gguf) {
  const tags = (model.tags || []).map((t) => t.toLowerCase());
  const arch = String((gguf && gguf.architecture) || '').toLowerCase();
  const caps = [];
  if (tags.includes('vision') || /vl|vision|omni|image/.test(arch)) caps.push('Vision');
  if (tags.includes('tools') || tags.includes('function-calling') || tags.includes('tool-use')) caps.push('Tools');
  if (tags.some((t) => /reason|thinking/.test(t))) caps.push('Reasoning');
  return caps;
}

/* ------------------------------------------------- minimal markdown */

function inlineMd(text) {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
      (m, label, url) => `<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`);
}

function tableMd(rows) {
  const cells = (row) => row.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
  const head = cells(rows[0]);
  const body = rows.slice(1).filter((r) => !/^[\s|:-]+$/.test(r)).map(cells);
  return `<table><thead><tr>${head.map((c) => `<th>${inlineMd(c)}</th>`).join('')}</tr></thead>`
    + `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

/** Line-based renderer. Escapes first, so model-authored markup can never inject. */
function renderMarkdown(src) {
  const text = String(src || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const out = [];
  let list = null, inFence = false, fence = [], table = [];

  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const closeTable = () => { if (table.length) { out.push(tableMd(table)); table = []; } };

  for (const raw of text.split(/\r?\n/)) {
    const line = esc(raw.replace(/\s+$/, ''));

    if (/^\s*```/.test(line)) {
      if (!inFence) { inFence = true; fence = []; closeList(); closeTable(); }
      else { inFence = false; out.push(`<pre><code>${fence.join('\n')}</code></pre>`); }
      continue;
    }
    if (inFence) { fence.push(line); continue; }
    if (!line.trim()) { closeList(); closeTable(); continue; }

    if (/^\s*\|.*\|\s*$/.test(line)) { table.push(line); continue; }
    closeTable();

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) { closeList(); const l = heading[1].length; out.push(`<h${l}>${inlineMd(heading[2])}</h${l}>`); continue; }

    if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) { closeList(); out.push('<hr>'); continue; }

    const quote = line.match(/^&gt;\s?(.*)$/);
    if (quote) { closeList(); out.push(`<blockquote>${inlineMd(quote[1])}</blockquote>`); continue; }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inlineMd(ul[1])}</li>`); continue; }

    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inlineMd(ol[1])}</li>`); continue; }

    closeList();
    out.push(`<p>${inlineMd(line)}</p>`);
  }
  closeList(); closeTable();
  if (inFence) out.push(`<pre><code>${fence.join('\n')}</code></pre>`);
  return out.join('\n');
}

/** First real sentence of a README, for the list rows. */
function firstParagraph(md) {
  for (const block of String(md || '').split(/\n\s*\n/)) {
    const t = block
      .replace(/^---[\s\S]*?---/, '')
      .replace(/^#+\s.*$/gm, '')
      .replace(/<[^>]+>/g, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (t.length > 40 && !/^\[\!\[/.test(t)) return t.slice(0, 180);
  }
  return '';
}

/* ==================================================================== */
/*  Runner + engine API                                                  */
/* ==================================================================== */

async function runner(path, options) {
  const r = await fetch(`${CFG.runner}${path}`, options);
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r;
}

/** Refresh the model list, the active model, and whether the engine is up. */
async function loadLocal() {
  try {
    const [models, engine] = await Promise.all([
      runner('/api/models').then((r) => r.json()),
      fetch(`${CFG.llama}/health`).then((r) => r.ok).catch(() => false),
    ]);
    state.local = models.models || [];
    state.active = models.active || null;
    state.runnerUp = true;
    state.runnerErr = null;
    state.engineUp = Boolean(engine) && Boolean(state.active);
  } catch (err) {
    state.runnerUp = false;
    state.runnerErr = err.message || String(err);
    state.engineUp = false;
    state.local = [];
    state.active = null;
  }
}

/** Stream a download from the runner. Progress arrives as NDJSON lines. */
async function downloadModel(repo, files, onEvent) {
  const r = await runner('/api/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo, files }),
  });
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try { onEvent(JSON.parse(line)); } catch { /* partial line */ }
    }
  }
  if (buffer.trim()) { try { onEvent(JSON.parse(buffer.trim())); } catch { /* ignore */ } }
}

const isServed = (file) => state.engineUp && state.active === file;

/* ==================================================================== */
/*  Views                                                                */
/* ==================================================================== */

const mainEl = $('#main');
const listEl = $('#list');

function render() {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === state.view));
  if (state.view === 'discover') { renderDiscoverList(); renderDetail(); }
  else { renderLibraryList(); renderLibrary(); }
}

/* ------------------------------------------------------------- discover */

function fitChip(f, small = false) {
  const title = f.reason ? `${f.label} — ${f.reason}` : f.label;
  return `<span class="fit ${f.cls}${small ? ' sm' : ''}" title="${esc(title)}">${esc(f.label)}</span>`;
}

function avatarHtml(id, cls) {
  const letter = esc((String(id).split('/').pop() || '?').trim().charAt(0).toUpperCase() || '?');
  const hue = [...String(id).split('/')[0]].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
  return `<div class="${cls} avatar" data-org="${esc(String(id).split('/')[0])}"
            style="background:hsl(${hue} 45% 32%)">${letter}</div>`;
}

function renderDiscoverList() {
  if (state.loading) {
    listEl.innerHTML = Array.from({ length: 6 }, () => `
      <div class="skel"><div class="k" style="width:40px;height:40px"></div>
      <div style="flex:1"><div class="k" style="height:13px;width:60%"></div>
      <div class="k" style="height:11px;width:90%;margin-top:8px"></div></div></div>`).join('');
    return;
  }
  if (!state.models.length) {
    listEl.innerHTML = `<div class="empty">${state.offline
      ? 'Hugging Face is unreachable. Showing the offline catalogue.'
      : 'No models matched that search.'}</div>`;
    return;
  }

  listEl.innerHTML = state.models.map((m) => {
    const f = m._fit ? m._fit.overall : { label: 'Unknown', cls: 'v-unknown', reason: '' };
    const desc = m._desc || 'GGUF · ' + (m._caps || []).concat([`${fmtNum(m.downloads || 0)} downloads`]).join(' · ');
    return `<div class="row${m.id === state.selectedId ? ' sel' : ''}" data-id="${esc(m.id)}">
      ${avatarHtml(m.id, '')}
      <div class="row-body">
        <div class="row-head">
          <span class="row-title">${esc(String(m.id).split('/').pop().replace(/-GGUF$/i, ''))}</span>
          <span class="verified" title="Verified publisher">${svg(ICON.check)}</span>
        </div>
        <div class="row-desc">${esc(desc)}</div>
        <div class="row-time">${fitChip(f, true)} ${esc(fromNow(m.lastModified))}</div>
      </div>
      <div class="row-meta">
        ${svg(ICON.clock)}${svg(ICON.chart)}${svg(ICON.info)}
      </div>
    </div>`;
  }).join('');

  // hydrate avatars + descriptions lazily
  $$('.row', listEl).forEach((row) => {
    const model = state.models.find((m) => m.id === row.dataset.id);
    if (model) hydrateRow(model, row);
  });
}

function hydrateRow(model, row) {
  hfAvatar(model.id).then((url) => {
    if (!url) return;
    const holder = $('.avatar', row);
    if (holder) {
      const img = new Image();
      img.src = url;
      img.className = 'avatar';
      img.alt = '';
      img.onload = () => holder.replaceWith(img);
    }
  });

  hfReadme(model.id).then((md) => {
    const desc = firstParagraph(md);
    if (!desc) return;
    model._desc = desc;
    const node = $('.row-desc', row);
    if (node) node.textContent = desc;
  });

  // Refine the estimated badge with exact sizes once the row is interesting to the user.
  row.addEventListener('mouseenter', () => {
    setTimeout(() => { if (row.matches(':hover')) refineFit(model.id); }, 500);
  }, { once: true });
}

async function refineFit(id) {
  if (detailCache.has(id)) return;
  try {
    const detail = await hfDetail(id);
    const { sizes } = parseGgufFiles(detail.siblings);
    if (!Object.keys(sizes).length) return;
    const model = state.models.find((m) => m.id === id);
    if (!model) return;
    const total = detail.gguf && detail.gguf.total;
    const paramsB = total ? total / 1e9 : (paramsFromName(id) || 0);
    model._fit = fitModel(id, { paramsB, sizes });
    model._exact = true;
    if (state.sort === 'best') { sortModels(); renderDiscoverList(); }
  } catch { /* estimate stands */ }
}

function sortModels() {
  if (state.sort === 'best') {
    state.models.sort((a, b) => fitScore(b) - fitScore(a));
  }
}

async function loadDiscover() {
  state.loading = true;
  renderDiscoverList();

  if (state.sort === 'best') sortModels();   // keep order stable while fetching

  try {
    const items = await hfSearch();
    state.offline = false;
    state.models = items.map((m) => {
      const paramsB = paramsFromName(m.id);
      const fitInfo = fitModel(m.id, { paramsB });
      return { ...m, _fit: fitInfo, _caps: capabilitiesOf(m, null) };
    });
    sortModels();
    state.models = state.models.slice(0, CFG.pageSize);
  } catch (err) {
    state.offline = true;
    state.models = OFFLINE_CATALOGUE.map((m) => {
      const fitInfo = fitModel(m.id, { paramsB: paramsFromName(m.id) });
      return { ...m, _fit: fitInfo, _caps: [] };
    });
    sortModels();
  }

  state.loading = false;
  if (!state.models.some((m) => m.id === state.selectedId)) {
    state.selectedId = state.models.length ? state.models[0].id : null;
  }
  render();
  if (state.selectedId) selectModel(state.selectedId);
}

async function selectModel(id) {
  state.selectedId = id;
  state.quant = null;
  state.detail = null;
  renderDiscoverList();
  renderDetail();

  try {
    const [detail, readme] = await Promise.all([hfDetail(id), hfReadme(id)]);
    const { sizes } = parseGgufFiles(detail.siblings);
    const gguf = detail.gguf || {};
    const paramsB = gguf.total ? gguf.total / 1e9 : (paramsFromName(id) || 0);
    const fitInfo = fitModel(id, { paramsB, sizes: Object.keys(sizes).length ? sizes : null });

    const model = state.models.find((m) => m.id === id);
    if (model) { model._fit = fitInfo; model._exact = true; model._desc = firstParagraph(readme) || model._desc; }

    state.detail = { id, model: detail, gguf, readme, fitInfo };
    state.quant = fitInfo.recommended;
    if (state.sort === 'best') { sortModels(); renderDiscoverList(); }
    renderDetail();
  } catch (err) {
    state.detail = { id, error: err.message || String(err) };
    renderDetail();
  }
}

/* --------------------------------------------------------------- detail */

function renderDetail() {
  if (state.view !== 'discover') return;

  if (!state.selectedId) { mainEl.innerHTML = `<div class="empty">Search for a model to get started.</div>`; return; }

  const model = state.models.find((m) => m.id === state.selectedId);
  if (!state.detail || state.detail.id !== state.selectedId) {
    mainEl.innerHTML = `<div class="detail">
      <div class="d-head">${avatarHtml(state.selectedId, 'd-avatar')}
        <div><h1 class="d-title">${esc(String(state.selectedId).split('/').pop())}</h1>
        <div class="d-sub">${esc(state.selectedId)}</div></div></div>
      <div class="box" style="margin-top:22px"><div class="empty">Loading model details…</div></div>
    </div>`;
    return;
  }

  if (state.detail.error) {
    mainEl.innerHTML = `<div class="detail">
      <div class="banner">Could not load this model from Hugging Face: ${esc(state.detail.error)}</div>
      <div class="d-head">${avatarHtml(state.selectedId, 'd-avatar')}
        <div><h1 class="d-title">${esc(String(state.selectedId).split('/').pop())}</h1>
        <div class="d-sub">${esc(state.selectedId)}</div></div></div>
    </div>`;
    return;
  }

  const { model: hfModel, gguf, readme, fitInfo } = state.detail;
  const quantList = fitInfo.quants.slice().sort((a, b) => quantRank(a.quant) - quantRank(b.quant) || a.sizeGB - b.sizeGB);
  const chosen = quantList.find((q) => q.quant === state.quant) || quantList[0];
  const chosenMeta = chosen && state.detail.meta ? state.detail.meta[chosen.quant] : null;
  const chosenFile = chosenMeta ? chosenMeta.file : null;
  const pullKey = `${state.selectedId}:${chosen ? chosen.quant : ''}`;
  const pull = state.pulls.get(pullKey);
  const localEntry = chosenFile ? state.local.find((m) => m.file === chosenFile) : null;

  const caps = capabilitiesOf(hfModel, gguf);
  const ctxLen = gguf.context_length;
  const formats = ['GGUF'].concat((hfModel.tags || []).some((t) => String(t).includes('mlx')) ? ['MLX'] : []);

  mainEl.innerHTML = `<div class="detail">

    <div class="d-head">
      ${avatarHtml(state.selectedId, 'd-avatar')}
      <div style="min-width:0">
        <h1 class="d-title">${esc(String(state.selectedId).split('/').pop().replace(/-GGUF$/i, ''))}</h1>
        <div class="d-sub">${esc(state.selectedId)}</div>
      </div>
    </div>

    <div class="pills">
      <span class="pill">${svg(ICON.download)}${esc(fmtNum(hfModel.downloads || 0))}</span>
      <span class="pill">${svg(ICON.star)}${esc(fmtNum(hfModel.likes || 0))}</span>
      <span class="pill muted">${svg(ICON.check)}Staff Pick</span>
      <span class="pill muted">${svg(ICON.clock)}Updated ${esc(fromNow(hfModel.lastModified))}</span>
      ${fitChip(fitInfo.overall)}
      <a class="pill link spacer" href="${esc(safeUrl(`${CFG.hf}/${state.selectedId}`))}"
         target="_blank" rel="noopener noreferrer">Open on Web ${svg(ICON.external)}</a>
    </div>

    <div class="section-head">
      <h2 class="section">Download Options</h2>
      <span class="to-label">Download to
        <span class="pill">${esc(CFG.targetLabel)} ${svg(ICON.chevron)}</span>
      </span>
    </div>

    <div class="box">
      <div class="qrow" id="qrow">
        <span class="fmt">GGUF</span>
        <span class="repo">${esc(String(state.selectedId).split('/').pop().replace(/-GGUF$/i, ''))}</span>
        <span class="quant">${esc(chosen ? chosen.quant : '—')}</span>
        <span class="size">${chosen ? esc(fmtBytes(chosen.sizeGB * 1e9)) : ''}</span>
        <span class="rec">${chosen && chosen.quant === fitInfo.recommended ? 'Recommended' : ''}</span>
        <span class="chev">${svg(ICON.chevron)}</span>
      </div>
      <div id="qmenu"></div>

      <div class="gpu-hint ${chosen ? chosen.fit.cls.replace('v-', 'h-') : ''}">
        ${svg(ICON.gpu)}${esc(chosen ? chosen.fit.label : '')}${chosen && chosen.fit.reason ? ' — ' + esc(chosen.fit.reason) : ''}
      </div>

      ${pull ? progressHtml(pull) : ''}

      <div class="dl-row">
        ${localEntry
          ? `<button class="btn-ghost danger" data-act="delete" data-file="${esc(localEntry.file)}">Remove</button>
             <button class="btn-primary" style="margin-left:8px" data-act="serve" data-file="${esc(localEntry.file)}">
               ${svg(ICON.play)}${isServed(localEntry.file) ? 'Serving' : 'Load'}</button>`
          : `<button class="btn-primary" id="downloadBtn" ${pull && !pull.done ? 'disabled' : ''}>
               ${svg(ICON.download)}${pull && pull.done ? 'Downloaded' : `Download ${chosen ? fmtBytes(chosen.sizeGB * 1e9) : ''}`}
             </button>`}
      </div>
      ${fitInfo.exact ? '' : '<div class="prose-note">Sizes are estimated from the parameter count until the file list loads.</div>'}
    </div>

    <h2 class="section">Details</h2>
    <div class="box">
      ${firstParagraph(readme) ? `<p class="desc">${esc(firstParagraph(readme))}</p>` : ''}
      <dl class="kv">
        ${gguf.total ? `<dt>Parameters</dt><dd><span class="chip">${esc(humanParams(gguf.total) || '')}</span></dd>` : ''}
        ${gguf.architecture ? `<dt>Architecture</dt><dd><span class="chip">${esc(gguf.architecture)}</span></dd>` : ''}
        ${ctxLen ? `<dt>Context</dt><dd><span class="chip">${esc(fmtNum(ctxLen))} tokens</span></dd>` : ''}
        <dt>Formats</dt><dd>${formats.map((f) => `<span class="chip">${esc(f)}</span>`).join('')}</dd>
        ${caps.length ? `<dt>Capabilities</dt><dd>${caps.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</dd>` : ''}
        <dt>Files</dt><dd><span class="chip">${quantList.length} quantisations</span></dd>
      </dl>
    </div>

    <h2 class="section">README</h2>
    <div class="box"><div class="readme">${renderMarkdown(readme) || '<p class="empty">No README.</p>'}</div></div>
  </div>`;

  wireDetail(quantList, state.selectedId, chosenFile, pullKey);
}

function progressHtml(p) {
  const pct = p.total ? clamp((p.completed / p.total) * 100, 0, 100) : 0;
  const left = p.total && p.speed > 0 ? (p.total - p.completed) / p.speed : 0;
  const eta = left > 0 ? `${Math.floor(left / 60)}m ${Math.round(left % 60)}s left` : '';
  return `<div class="prog">
    <div class="prog-bar"><div class="prog-fill" style="width:${pct}%"></div></div>
    <div class="prog-meta">
      <span>${esc(p.error ? p.error : p.status)}</span>
      <span>${p.total ? `${esc(fmtBytes(p.completed))} / ${esc(fmtBytes(p.total))} · ${pct.toFixed(0)}%` : ''}
      ${p.speed > 0 ? ` · ${esc(fmtBytes(p.speed))}/s` : ''} ${esc(eta)}</span>
    </div>
  </div>`;
}

function wireDetail(quantList, repoId, chosenFile, pullKey) {
  const qrow = $('#qrow');
  const qmenu = $('#qmenu');

  if (qrow) {
    qrow.addEventListener('click', () => {
      // Click again to collapse, so the menu is not a one-way door.
      if (qmenu.innerHTML) { qmenu.innerHTML = ''; return; }
      qmenu.innerHTML = `<div class="qmenu">${quantList.map((q) => `
        <button data-quant="${esc(q.quant)}" class="${q.quant === state.quant ? 'sel' : ''}">
          <span class="q">${esc(q.quant)}</span>
          <span class="s">${esc(fmtBytes(q.sizeGB * 1e9))}</span>
          <span class="tag">${esc(q.fit.label)}</span>
        </button>`).join('')}</div>`;
      $$('button', qmenu).forEach((b) => b.addEventListener('click', () => {
        state.quant = b.dataset.quant;
        renderDetail();
      }));
    });
  }

  const dl = $('#downloadBtn');
  if (dl && chosenFile) {
    dl.addEventListener('click', () => startDownload(repoId, chosenFile, chosenFile, pullKey));
  }

  $$('[data-act]', mainEl).forEach((b) => {
    const file = b.dataset.file;
    if (b.dataset.act === 'delete') b.addEventListener('click', () => removeModel(file));
    if (b.dataset.act === 'serve') b.addEventListener('click', () => loadModel(file));
  });
}

/* ------------------------------------------------------------ downloading */

function startDownload(repoId, fileName, _displayName, pullKey) {
  if (state.pulls.has(pullKey) && !state.pulls.get(pullKey).done) return;

  const entry = { status: 'starting…', completed: 0, total: 0, speed: 0, done: false, error: null, t0: Date.now() };
  state.pulls.set(pullKey, entry);
  renderDetail();

  const tick = setInterval(() => {
    const p = state.pulls.get(pullKey);
    if (!p || p.done) { clearInterval(tick); return; }
    const node = mainEl.querySelector('.prog');
    if (!node) return;
    node.outerHTML = progressHtml(p);
  }, 400);

  downloadModel(repoId, [fileName], (evt) => {
    const p = state.pulls.get(pullKey);
    if (!p) return;
    if (evt.error) { p.error = evt.error; p.done = true; return; }
    p.status = evt.status || p.status;
    if (typeof evt.completed === 'number') p.completed = evt.completed;
    if (typeof evt.total === 'number') p.total = evt.total;
    const elapsed = (Date.now() - p.t0) / 1000;
    if (elapsed > 0.5 && p.completed) p.speed = p.completed / elapsed;
    if (evt.status === 'success') p.done = true;
  }).then(async () => {
    const p = state.pulls.get(pullKey);
    if (p) p.done = true;
    clearInterval(tick);
    await loadLocal();
    renderDetail();
  }).catch((err) => {
    const p = state.pulls.get(pullKey);
    if (p) { p.error = err.message || String(err); p.done = true; }
    clearInterval(tick);
    renderDetail();
  });
}

async function removeModel(file) {
  if (!confirm(`Delete ${file} from the model store?`)) return;
  try {
    await runner(`/api/models/${encodeURIComponent(file)}`, { method: 'DELETE' });
  } catch (err) { alert(`Could not delete: ${err.message}`); }
  await loadLocal();
  render();
}

/** Point the engine at a downloaded GGUF; the supervisor loop reloads it. */
async function loadModel(file) {
  try {
    await runner('/api/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file }),
    });
  } catch (err) { alert(`Could not load: ${err.message}`); }
  await new Promise((r) => setTimeout(r, 1200)); // let the supervisor pick it up
  await loadLocal();
  render();
}

/* -------------------------------------------------------------- library */

function renderLibraryList() {
  if (state.view !== 'library') return;
  const q = state.query.toLowerCase();
  const items = q ? state.local.filter((m) => m.file.toLowerCase().includes(q)) : state.local;
  listEl.innerHTML = items.length
    ? items.map((m) => `<div class="row${m.file === state.active ? ' sel' : ''}" data-name="${esc(m.file)}">
        ${avatarHtml(m.file, '')}
        <div class="row-body">
          <div class="row-head"><span class="row-title">${esc(m.file)}</span></div>
          <div class="row-desc">${esc(fmtBytes(m.size))}</div>
          <div class="row-time">${isServed(m.file) ? 'serving' : 'stopped'}</div>
        </div>
      </div>`).join('')
    : `<div class="empty">Nothing downloaded yet. Find a model in Discover.</div>`;
}

function renderLibrary() {
  if (state.view !== 'library') return;
  const hw = state.hw;
  const totalBytes = state.local.reduce((a, m) => a + (m.size || 0), 0);

  const banner = !state.runnerUp
    ? `<div class="banner">The runner is not reachable (<code>${esc(CFG.runner)}</code>).
        ${esc(state.runnerErr || '')} Start the stack with <code>docker compose up -d</code>.</div>`
    : (!state.engineUp && state.local.length
      ? `<div class="banner warn">The engine is not serving yet. Load a model below, or check
         <code>docker compose logs llama</code> if loading fails.</div>`
      : (!hw.detected
        ? `<div class="banner warn">No <code>hardware.json</code> yet, so fit badges use conservative defaults.
           Run <code>make retune</code> to profile this machine.</div>`
        : (hw.gpu.backend !== 'cpu' && hw.containerGpu === false
          ? `<div class="banner warn">A <strong>${esc(hw.gpu.name)}</strong> was detected, but Docker cannot use it yet,
             so models will run on the CPU. Install <code>nvidia-container-toolkit</code>, then
             <code>make up-gpu</code>.</div>`
          : '')));

  mainEl.innerHTML = `<div class="detail">
    <div class="lib-head">
      <div>
        <h1 class="d-title">Library</h1>
        <div class="d-sub">GGUF files stored on disk, and which one the engine is serving.</div>
      </div>
      <button class="btn-ghost" id="refreshLib">${svg(ICON.refresh)} Refresh</button>
    </div>

    ${banner}

    <div class="stat">
      <div><span>Models</span><b>${state.local.length}</b></div>
      <div><span>On disk</span><b>${esc(fmtBytes(totalBytes))}</b></div>
      <div><span>Serving</span><b>${state.engineUp && state.active ? 1 : 0}</b></div>
      <div><span>VRAM budget</span><b>${Number(hw.gpu.vramUsableGB) > 0 ? Number(hw.gpu.vramUsableGB).toFixed(0) + ' GB' : '--'}</b></div>
    </div>

    <h2 class="section">Endpoints</h2>
    <div class="box">
      ${endpointHtml('OpenAI API', `${location.protocol}//${location.hostname}:${CFG.llamaPort || 8081}/v1`)}
      <div class="prose-note">Point any OpenAI-compatible client at this address. The model name is the loaded GGUF file.</div>
    </div>

    <h2 class="section">System</h2>
    <div class="box">
      <dl class="kv">
        <dt>GPU</dt><dd><span class="chip">${esc(hw.gpu.name)}</span>
          ${hw.gpu.computeCapability ? `<span class="chip">cc ${esc(hw.gpu.computeCapability)}</span>` : ''}
          <span class="chip">${esc(hw.gpu.backend)}</span></dd>
        <dt>VRAM</dt><dd><span class="chip">${esc(String(hw.gpu.vramUsableGB))} GB usable</span>
          <span class="chip">${esc(String(hw.gpu.vramTotalGB))} GB total</span></dd>
        <dt>RAM</dt><dd><span class="chip">${esc(String(hw.ram.usableGB))} GB usable</span>
          <span class="chip">${esc(String(hw.ram.totalGB))} GB total</span></dd>
        <dt>Context</dt><dd><span class="chip">${esc(fmtNum(hw.targetContext))}</span></dd>
        <dt>KV cache</dt><dd><span class="chip">${esc(hw.kvCacheType)}</span></dd>
        <dt>Flash attn</dt><dd><span class="chip">${hw.flashAttention ? 'on' : 'off'}</span></dd>
        <dt>Docker GPU</dt><dd><span class="chip">${hw.containerGpu ? 'available' : 'not available'}</span></dd>
        ${hw.generated ? `<dt>Profiled</dt><dd><span class="chip">${esc(fromNow(hw.generated))}</span></dd>` : ''}
      </dl>
      ${(hw.notes || []).length ? `<div class="notes">${hw.notes.map((n) => `<p>${esc(n)}</p>`).join('')}</div>` : ''}
    </div>

    <h2 class="section">Models</h2>
    ${state.local.length ? state.local.map((m) => {
      const served = isServed(m.file);
      return `<div class="mrow">
        <div class="m-body">
          <div class="m-name">${esc(m.file)}</div>
          <div class="m-meta">
            <span class="dot${served ? ' on' : ''}"><i></i>${served ? 'serving' : 'stopped'}</span>
            <span>${esc(fmtBytes(m.size))}</span>
            <span>${esc(fromNow(m.mtime))}</span>
          </div>
        </div>
        <div class="m-actions">
          <button class="btn-ghost" data-act="serve" data-file="${esc(m.file)}">${svg(ICON.play)}${served ? 'Reload' : 'Load'}</button>
          <button class="btn-ghost danger" data-act="delete" data-file="${esc(m.file)}">${svg(ICON.trash)}</button>
        </div>
      </div>`;
    }).join('') : `<div class="empty">No models on disk yet.</div>`}
  </div>`;

  $('#refreshLib').addEventListener('click', async () => { await loadLocal(); render(); });
  $$('[data-act]', mainEl).forEach((b) => {
    const file = b.dataset.file;
    if (b.dataset.act === 'delete') b.addEventListener('click', () => removeModel(file));
    if (b.dataset.act === 'serve') b.addEventListener('click', () => loadModel(file));
  });
}

function endpointHtml(label, url) {
  return `<div class="endpoint">
    <span class="lbl">${esc(label)}</span>
    <code>${esc(url)}</code>
    <button data-copy="${esc(url)}" title="Copy">${svg(ICON.copy)}</button>
  </div>`;
}

/* ------------------------------------------------------- offline sample */

const OFFLINE_CATALOGUE = [
  { id: 'Qwen/Qwen3.8-27B', downloads: 872724, likes: 146, lastModified: new Date(Date.now() - 62 * 864e5).toISOString() },
  { id: 'prism-ml/Bonsai-27B-GGUF', downloads: 210340, likes: 88, lastModified: new Date(Date.now() - 79 * 864e5).toISOString() },
  { id: 'google/gemma-4-12b-it-qat-GGUF', downloads: 154221, likes: 64, lastModified: new Date(Date.now() - 75 * 864e5).toISOString() },
  { id: 'google/gemma-4-26b-a4b-it-qat-GGUF', downloads: 133908, likes: 51, lastModified: new Date(Date.now() - 75 * 864e5).toISOString() },
  { id: 'google/gemma-4-31b-it-qat-GGUF', downloads: 121455, likes: 47, lastModified: new Date(Date.now() - 75 * 864e5).toISOString() },
  { id: 'google/gemma-4-12b-it-GGUF', downloads: 118772, likes: 43, lastModified: new Date(Date.now() - 75 * 864e5).toISOString() },
  { id: 'Qwen/Qwen3.6-27B-GGUF', downloads: 96431, likes: 39, lastModified: new Date(Date.now() - 137 * 864e5).toISOString() },
  { id: 'Qwen/Qwen3.6-35B-A3B-GGUF', downloads: 91220, likes: 36, lastModified: new Date(Date.now() - 137 * 864e5).toISOString() },
  { id: 'google/gemma-4-31b-it-GGUF', downloads: 88940, likes: 33, lastModified: new Date(Date.now() - 75 * 864e5).toISOString() },
  { id: 'google/gemma-4-e4b-it-GGUF', downloads: 84550, likes: 30, lastModified: new Date(Date.now() - 75 * 864e5).toISOString() },
  { id: 'google/gemma-4-e2b-it-GGUF', downloads: 81230, likes: 28, lastModified: new Date(Date.now() - 75 * 864e5).toISOString() },
  { id: 'nvidia/Nemotron-3-Nano-4B-GGUF', downloads: 74890, likes: 24, lastModified: new Date(Date.now() - 216 * 864e5).toISOString() },
  { id: 'Qwen/Qwen3.5-9B-GGUF', downloads: 71204, likes: 22, lastModified: new Date(Date.now() - 137 * 864e5).toISOString() },
];

/* ==================================================================== */
/*  Events                                                               */
/* ==================================================================== */

function wireSortMenu() {
  const btn = $('#sortBtn');
  const menu = $('#sortMenu');
  $('#sortLabel').textContent = SORT_LABELS[state.sort];

  btn.addEventListener('click', () => {
    menu.classList.toggle('hidden');
    if (menu.classList.contains('hidden')) return;
    menu.innerHTML = Object.entries(SORT_LABELS).map(([key, label]) =>
      `<button data-sort="${key}" class="${key === state.sort ? 'sel' : ''}">${esc(label)}</button>`).join('');
    $$('button', menu).forEach((b) => b.addEventListener('click', () => {
      state.sort = b.dataset.sort;
      $('#sortLabel').textContent = SORT_LABELS[state.sort];
      menu.classList.add('hidden');
      loadDiscover();
    }));
  });

  document.addEventListener('click', (e) => {
    if (!$('#sortDD').contains(e.target)) menu.classList.add('hidden');
  });
}

function wireStaffToggle() {
  const btn = $('#staffBtn');
  btn.addEventListener('click', () => {
    state.staffPicks = !state.staffPicks;
    btn.classList.toggle('on', state.staffPicks);
    if (state.view === 'discover') loadDiscover();
  });
}

function wireSearch() {
  let timer;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(timer);
    const value = e.target.value.trim();
    timer = setTimeout(() => {
      state.query = value;
      if (state.view === 'discover') loadDiscover();
      else renderLibraryList();
    }, 350);
  });
}

function wireTabs() {
  $$('.tab').forEach((tab) => tab.addEventListener('click', async () => {
    const view = tab.dataset.view;
    if (view === state.view) return;
    state.view = view;
    if (view === 'library') {
      state.selectedId = null;
      await loadLocal();
    } else if (!state.selectedId && state.models.length) {
      state.selectedId = state.models[0].id;
    }
    render();
    // Re-open the model the user was reading before they wandered off.
    if (view === 'discover' && state.selectedId) selectModel(state.selectedId);
  }));
}

/** One listener for the whole list, for rows that exist only after a repaint. */
function wireList() {
  listEl.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    if (state.view === 'discover' && row.dataset.id) {
      if (row.dataset.id !== state.selectedId) selectModel(row.dataset.id);
    } else if (state.view === 'library' && row.dataset.name) {
      // Clicking a library row loads that model in the engine.
      const file = row.dataset.name;
      if (file !== state.active) loadModel(file);
      state.active = file;
      renderLibraryList();
      renderLibrary();
    }
  });
}

async function wireCopy() {
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      btn.innerHTML = svg(ICON.check);
      setTimeout(() => { btn.innerHTML = svg(ICON.copy); }, 1200);
    } catch { /* clipboard blocked */ }
  });
}

/* ==================================================================== */
/*  Boot                                                                 */
/* ==================================================================== */

async function init() {
  wireSortMenu();
  wireStaffToggle();
  wireSearch();
  wireTabs();
  wireList();
  wireCopy();

  await Promise.all([loadHardware(), loadLocal()]);
  await loadDiscover();

  // Keep served state fresh without hammering the engine. Only the Library is
  // repainted on a timer -- redrawing the Discover detail panel would collapse
  // an open quant menu and throw away the reader's scroll position.
  setInterval(async () => {
    if (document.hidden) return;
    await loadLocal();
    if (state.view === 'library') renderLibrary();
  }, 10000);
}

init();
