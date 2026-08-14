/**
 * Persistence layer for Helpry.
 *
 * Storage precedence (auto-detected from env vars, no code change needed):
 *   1. Upstash Redis  (Vercel's current recommended store) when UPSTASH_REDIS_REST_URL
 *      and UPSTASH_REDIS_REST_TOKEN are present (Redis.fromEnv()).
 *   2. Vercel KV      when KV_REST_API_URL / KV_REST_API_TOKEN are present (legacy).
 *   3. Local file      data/state.json — used by `npm start` / `node server.js` with no DB.
 *
 * All three paths run the SAME code, so connecting GitHub -> Vercel -> (Upstash) just
 * works. Conversations persist durably in (1)/(2), and survive reloads/restarts in (3).
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

function defaultState() {
  return { nextClientId: 1, nextMessageId: 1, clients: [] };
}

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
  if (backend && backend.type === 'upstash') {
    await backend.redis.set('helpry:state', state);
    return;
  }
  if (backend && backend.type === 'kv') {
    await backend.kv.set('helpry:state', state);
    return;
  }
  // File backend
  await ensureDataDir();
  memState = state;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

module.exports = {
  getState,
  saveState,
  defaultState,
  isUsingKV: () => backend && backend.type === 'kv',
  isUsingKVClassic: () => backend && backend.type === 'kv',
  isUsingUpstash: () => backend && backend.type === 'upstash'
};
