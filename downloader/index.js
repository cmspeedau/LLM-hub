// LLM Hub runner -- the piece LM Studio has that a raw llama-server does not:
// it pulls GGUF files from Hugging Face, manages the models directory, and
// switches the active model by rewriting /models/.active, which the llama
// container's supervisor loop picks up.
//
// No dependencies. Node >= 18 (global fetch).
//
//   GET    /api/models                 list .gguf files
//   GET    /api/status                 active model + current download progress
//   POST   /api/download               { repo, files: [name, ...] }  (NDJSON progress)
//   POST   /api/load                   { file }  switch the active model
//   DELETE /api/models/:file           remove a model file

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const MODELS_DIR = process.env.MODELS_DIR || '/models';
const ACTIVE_FILE = path.join(MODELS_DIR, '.active');
const PORT = Number(process.env.PORT || 3000);
const HF = 'https://huggingface.co';

if (!fs.existsSync(MODELS_DIR)) fs.mkdirSync(MODELS_DIR, { recursive: true });

// Only one download at a time -- these files are gigabytes.
let job = null; // { repo, files, total, completed, error, done, startedAt }

function send(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function listModels() {
  return fs.readdirSync(MODELS_DIR)
    .filter((f) => f.toLowerCase().endsWith('.gguf'))
    .map((f) => {
      const st = fs.statSync(path.join(MODELS_DIR, f));
      return { file: f, size: st.size, mtime: st.mtime.toISOString() };
    })
    .sort((a, b) => a.file.localeCompare(b.file));
}

function activeModel() {
  try {
    const f = fs.readFileSync(ACTIVE_FILE, 'utf8').trim();
    if (f && fs.existsSync(path.join(MODELS_DIR, f))) return f;
  } catch { /* none set */ }
  return null;
}

function setActive(file) {
  fs.writeFileSync(ACTIVE_FILE, file + '\n');
}

async function hfRepoFiles(repo, files) {
  const r = await fetch(`${HF}/api/models/${repo}`);
  if (!r.ok) throw new Error(`Hugging Face returned ${r.status} for ${repo}`);
  const meta = await r.json();
  const siblings = meta.siblings || [];
  const out = [];
  let total = 0;
  for (const name of files) {
    const s = siblings.find((x) => x.rfilename === name);
    if (!s) throw new Error(`File not found in repo: ${name}`);
    out.push({ name, size: Number(s.size || 0) });
    total += Number(s.size || 0);
  }
  return { parts: out, total };
}

async function downloadPart(repo, part, onProgress) {
  const url = `${HF}/${repo}/resolve/main/${part.name}`;
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error(`${part.name}: HTTP ${r.status}`);

  const tmp = path.join(MODELS_DIR, part.name + '.part');
  const dst = path.join(MODELS_DIR, part.name);
  const file = fs.createWriteStream(tmp);

  let done = 0;
  let lastEmit = 0;
  const report = () => onProgress(done, Date.now() - lastEmit > 300);

  await new Promise((resolve, reject) => {
    const reader = r.body.getReader();
    const pump = async () => {
      try {
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          file.write(Buffer.from(value));
          done += value.byteLength;
          report();
        }
        file.end((err) => (err ? reject(err) : resolve()));
      } catch (e) { file.close(); reject(e); }
    };
    pump();
  });

  fs.renameSync(tmp, dst);
  return done;
}

async function runDownload(res, repo, files) {
  const { parts, total } = await hfRepoFiles(repo, files);
  job = { repo, files: parts, total, completed: 0, error: null, done: false, startedAt: Date.now() };

  // Stream NDJSON progress to the caller.
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
  const emit = () => {
    res.write(JSON.stringify({
      status: job.error ? 'error' : job.done ? 'success' : 'downloading',
      completed: job.completed, total: job.total, error: job.error,
    }) + '\n');
  };

  const onProgress = (delta, flush) => {
    job.completed += delta;
    if (flush) emit();
  };

  try {
    for (const part of parts) {
      const n = await downloadPart(repo, part, onProgress);
      job.completed += 0; // progress already counted by bytes
      if (n < 0) throw new Error(`short read on ${part.name}`);
    }
    if (job.completed === 0) job.completed = job.total; // sizes unknown but finished
    job.done = true;
    setActive(parts[parts.length - 1].name);
    emit();
  } catch (err) {
    job.error = err.message || String(err);
    job.done = true;
    emit();
  }
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/api/models') {
      return send(res, 200, { models: listModels(), active: activeModel() });
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      return send(res, 200, {
        active: activeModel(),
        download: job && !job.done ? job : (job && job.error ? job : null),
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/download') {
      if (job && !job.done) return send(res, 409, { error: 'a download is already running' });
      const body = await readBody(req);
      const repo = String(body.repo || '').replace(/^hf\.co\//, '');
      const files = Array.isArray(body.files) ? body.files.map(String) : [];
      if (!repo || !files.length || files.some((f) => f.includes('/') || f.includes('..'))) {
        return send(res, 400, { error: 'expected { repo, files: ["file.gguf", ...] }' });
      }
      return runDownload(res, repo, files);
    }

    if (req.method === 'POST' && url.pathname === '/api/load') {
      const body = await readBody(req);
      const file = String(body.file || '');
      if (!file.endsWith('.gguf') || file.includes('/') || file.includes('..')) {
        return send(res, 400, { error: 'bad file name' });
      }
      if (!fs.existsSync(path.join(MODELS_DIR, file))) return send(res, 404, { error: 'not found' });
      setActive(file);
      return send(res, 200, { active: file });
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/models/')) {
      const file = decodeURIComponent(url.pathname.slice('/api/models/'.length));
      if (!file.endsWith('.gguf') || file.includes('..')) return send(res, 400, { error: 'bad file name' });
      const dst = path.join(MODELS_DIR, file);
      if (!fs.existsSync(dst)) return send(res, 404, { error: 'not found' });
      fs.unlinkSync(dst);
      if (activeModel() === file) { try { fs.unlinkSync(ACTIVE_FILE); } catch { /* ok */ } }
      return send(res, 200, { ok: true });
    }

    send(res, 404, { error: 'not found' });
  } catch (err) {
    send(res, 500, { error: err.message || String(err) });
  }
});

server.listen(PORT, () => console.log(`[llm-hub runner] listening on :${PORT}`));
