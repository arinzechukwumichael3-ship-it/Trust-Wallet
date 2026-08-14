/**
 * Persistence layer for Helpry.
 *
 * Storage precedence (auto-detected from env vars, no code change needed):
 *   1. Upstash Redis  (Vercel's current recommended store) when UPSTASH_REDIS_REST_URL
 *      and UPSTASH_REDIS_REST_TOKEN are present (Redis.fromEnv()).
 *   2. Vercel KV      when KV_REST_API_URL / KV_REST_API_TOKEN are present (legacy).
 *   3. Local file     data/state.json — used by `npm start` / `node server.js` locally.
 *
 * On Vercel's serverless runtime the project directory is READ-ONLY, so the file
 * backend falls back to /tmp (the only writable path there). Writes there are
 * ephemeral (lost on cold start, not shared across instances) — fine for a demo,
 * but link Upstash Redis for real durability. All paths are wrapped so a failed
 * write can NEVER crash the function (which would surface as HTTP 000 to clients).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECT_DATA_DIR = path.join(__dirname, '..', 'data');
const PROJECT_STATE_FILE = path.join(PROJECT_DATA_DIR, 'state.json');
const TMP_STATE_FILE = path.join(os.tmpdir(), 'helpry-state.json');

function defaultState() {
  return { nextClientId: 1, nextMessageId: 1, clients: [] };
}

// Pick a writable state file. Prefer the project data/ dir (local dev); if it is
// not writable (Vercel read-only FS), use /tmp.
let STATE_FILE = PROJECT_STATE_FILE;
function pickWritableStateFile() {
  try {
    if (!fs.existsSync(PROJECT_DATA_DIR)) fs.mkdirSync(PROJECT_DATA_DIR, { recursive: true });
    const probe = path.join(PROJECT_DATA_DIR, '.write-test');
    fs.writeFileSync(probe, '1');
    fs.unlinkSync(probe);
    return PROJECT_STATE_FILE;
  } catch (e) {
    console.warn('Project data dir not writable, using /tmp for state:', e.message);
    return TMP_STATE_FILE;
  }
}
STATE_FILE = pickWritableStateFile();

// --- Backend detection -------------------------------------------------------
let backend = null; // 'upstash' | 'kv' | 'file'

if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  try {
    const { Redis } = require('@upstash/redis');
    backend = { type: 'upstash', redis: Redis.fromEnv() };
  } catch (e) {
    console.error('Upstash env vars present but @upstash/redis failed to load:', e.message);
  }
}

if (!backend && process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
  try {
    const { kv } = require('@vercel/kv');
    backend = { type: 'kv', kv };
  } catch (e) {
    console.error('KV env vars present but @vercel/kv failed to load:', e.message);
  }
}

// file backend in-memory cache
let memState = null;
let memLoaded = false;

function normalize(raw) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const clients = Array.isArray(parsed.clients) ? parsed.clients : [];

  const maxClientId = clients.reduce((m, c) => Math.max(m, Number(c.id) || 0), 0);
  const maxMessageId = clients.reduce((m, c) => {
    const msgs = Array.isArray(c.messages) ? c.messages : [];
    return msgs.reduce((mm, msg) => Math.max(mm, Number(msg.id) || 0), m);
  }, 0);

  const storedClientId = Number(parsed.nextClientId || parsed.next_client_id || 1);
  const storedMessageId = Number(parsed.nextMessageId || parsed.next_message_id || 1);

  return {
    nextClientId: Math.max(storedClientId, maxClientId + 1),
    nextMessageId: Math.max(storedMessageId, maxMessageId + 1),
    clients
  };
}

async function getState() {
  if (backend && backend.type === 'upstash') {
    const raw = await backend.redis.get('helpry:state');
    if (!raw) {
      const d = defaultState();
      await backend.redis.set('helpry:state', d);
      return d;
    }
    return normalize(raw);
  }

  if (backend && backend.type === 'kv') {
    const raw = await backend.kv.get('helpry:state');
    if (!raw) {
      const d = defaultState();
      await backend.kv.set('helpry:state', d);
      return d;
    }
    return normalize(raw);
  }

  // File backend (project dir or /tmp fallback)
  if (memLoaded && memState) return memState;
  try {
    if (!fs.existsSync(STATE_FILE)) {
      const d = defaultState();
      memState = d;
      memLoaded = true;
      await saveState(d); // best-effort create
      return d;
    }
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    if (!raw.trim()) {
      const d = defaultState();
      memState = d;
      memLoaded = true;
      return d;
    }
    memState = normalize(raw);
    memLoaded = true;
    return memState;
  } catch (e) {
    console.error('Failed to load state, using in-memory default:', e.message);
    const d = defaultState();
    memState = d;
    memLoaded = true;
    return d;
  }
}

async function saveState(state) {
  if (backend && backend.type === 'upstash') {
    await backend.redis.set('helpry:state', state);
    return;
  }
  if (backend && backend.type === 'kv') {
    await backend.kv.set('helpry:state', state);
    return;
  }
  // File backend — never throw. Keep in-memory cache regardless, so a warm
  // instance still serves consistent state even if the disk write fails.
  memState = state;
  memLoaded = true;
  try {
    if (!fs.existsSync(path.dirname(STATE_FILE))) {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn('State file write failed (state kept in memory only):', e.message);
  }
}

async function ensureDataDir() {
  if (!fs.existsSync(path.dirname(STATE_FILE))) {
    try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); } catch (e) { /* ignore */ }
  }
}

module.exports = {
  getState,
  saveState,
  defaultState,
  isUsingKV: () => backend && backend.type === 'kv',
  isUsingKVClassic: () => backend && backend.type === 'kv',
  isUsingUpstash: () => backend && backend.type === 'upstash'
};
