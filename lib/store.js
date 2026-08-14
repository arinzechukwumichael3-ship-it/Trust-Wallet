/**
 * Persistence layer for Helpry.
 *
 * - On Vercel: when a Vercel KV store is linked to the project, the environment
 *   variables KV_REST_API_URL / KV_REST_API_TOKEN are injected automatically and
 *   we persist the whole state blob to KV (durable, shared across functions).
 * - Locally (or anywhere without KV env vars): we persist to data/state.json.
 *
 * The same code path works in both places, so connecting GitHub + Vercel + KV
 * "just works" with zero code changes.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

function defaultState() {
  return { nextClientId: 1, nextMessageId: 1, clients: [] };
}

// Detect a linked Vercel KV store. The @vercel/kv package reads KV_REST_API_URL
// and KV_REST_API_TOKEN directly, but we only require it when those vars exist
// so that a plain `node server.js` never needs the dependency at runtime.
let kv = null;
let useKV = false;
if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
  try {
    kv = require('@vercel/kv').kv;
    useKV = true;
  } catch (e) {
    console.error('KV env vars present but @vercel/kv failed to load:', e.message);
    useKV = false;
  }
}

// In-memory cache for the file backend (persists within a single process run).
let memState = null;
let memLoaded = false;

/**
 * Normalize a raw state object into a valid one.
 * Tolerates both snake_case (Python backend) and camelCase (Node backend) keys,
 * and derives the next ids from the highest existing id so duplicate ids can
 * never break admin<->client message matching.
 */
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

async function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

async function getState() {
  if (useKV) {
    const raw = await kv.get('helpry:state');
    if (!raw) {
      const d = defaultState();
      await kv.set('helpry:state', d);
      return d;
    }
    return normalize(raw);
  }

  // File backend
  await ensureDataDir();
  if (memLoaded && memState) return memState;
  try {
    if (!fs.existsSync(STATE_FILE)) {
      const d = defaultState();
      fs.writeFileSync(STATE_FILE, JSON.stringify(d, null, 2));
      memState = d;
      memLoaded = true;
      return d;
    }
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    if (!raw.trim()) {
      const d = defaultState();
      fs.writeFileSync(STATE_FILE, JSON.stringify(d, null, 2));
      memState = d;
      memLoaded = true;
      return d;
    }
    memState = normalize(raw);
    memLoaded = true;
    return memState;
  } catch (e) {
    console.error('Failed to load state, resetting storage:', e.message);
    const d = defaultState();
    memState = d;
    memLoaded = true;
    return d;
  }
}

async function saveState(state) {
  if (useKV) {
    await kv.set('helpry:state', state);
    return;
  }
  await ensureDataDir();
  memState = state;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

module.exports = {
  getState,
  saveState,
  defaultState,
  isUsingKV: () => useKV
};
