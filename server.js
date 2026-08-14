const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const store = require('./lib/store');

// Minimal .env loader for local dev (Vercel injects env vars directly, so we
// only read a local .env file when present and not already set).
(function loadDotEnv() {
  try {
    const dotEnvPath = path.join(__dirname, '.env');
    if (!fs.existsSync(dotEnvPath)) return;
    const text = fs.readFileSync(dotEnvPath, 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined || process.env[key] === '') process.env[key] = val;
    }
  } catch (e) { /* ignore */ }
})();

const app = express();
const PORT = process.env.PORT || 5500;
const ROOT = __dirname;
// On Vercel, static assets live in /public (auto-served). Locally we serve them
// from there too so the same code path works in both environments.
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

// ---------------------------------------------------------------------------
// Admin authentication
//
// The admin console is protected with a single shared password set via the
// ADMIN_PASSWORD env var. When unset, a safe default is used (CHANGE THIS in
// production by setting ADMIN_PASSWORD in your Vercel project settings).
//
// The password is never sent back to the client. On successful login we set an
// HttpOnly, SameSite cookie holding a signed session token. Every /api/admin/*
// route checks that cookie. This is stateless (no server-side session store),
// so it works identically on the local file backend and on Vercel serverless.
// ---------------------------------------------------------------------------
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'helpry-admin';
if (ADMIN_PASSWORD === 'helpry-admin') {
  console.warn('\n⚠️  WARNING: ADMIN_PASSWORD is using the insecure default "helpry-admin".\n' +
    '   Set ADMIN_PASSWORD (Vercel env var) or .env to a strong password before going live.\n');
}
const AUTH_SECRET = process.env.AUTH_SECRET || crypto.createHash('sha256').update('helpry-admin-auth-' + ADMIN_PASSWORD).digest('hex');
const AUTH_COOKIE = 'helpry_admin';

function makeToken() {
  // signed value: random payload + HMAC, so it can't be forged without the secret
  const payload = crypto.randomBytes(16).toString('hex');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}
function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('hex');
  // constant-time compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireAdmin(req, res, next) {
  const token = req.cookies ? req.cookies[AUTH_COOKIE] : null;
  if (!verifyToken(token)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

function makeCacheLock() {
  return crypto.randomBytes(24).toString('hex');
}

function getClientByCacheLock(state, cacheLock) {
  return state.clients.find(client => client.cache_lock === cacheLock) || null;
}

function getClientById(state, clientId) {
  const id = Number(clientId);
  return state.clients.find(client => client.id === id) || null;
}

function sanitizeMessage(msg) {
  return {
    id: msg.id,
    sender_type: msg.sender_type,
    message: msg.message || '',
    image_urls: Array.isArray(msg.image_urls) ? msg.image_urls : [],
    created_at: msg.created_at || new Date().toISOString()
  };
}

function listClientMessages(client) {
  const list = Array.isArray(client.messages) ? client.messages : [];
  return list.slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).map(sanitizeMessage);
}

// ---------------------------------------------------------------------------
// Image persistence
//
// 1. Vercel Blob  — used automatically when BLOB_READ_WRITE_TOKEN is present.
// 2. Local disk   — public/uploads/*.jpg (works locally; on Vercel the function
//                   filesystem is ephemeral, so this is a best-effort fallback).
// 3. Data URL     — last-resort inline fallback so uploads never silently vanish.
// ---------------------------------------------------------------------------
async function persistImages(files) {
  const urls = [];
  if (!files || files.length === 0) return urls;

  const useBlob = !!process.env.BLOB_READ_WRITE_TOKEN;
  if (useBlob) {
    try {
      const { put } = require('@vercel/blob');
      for (const f of files) {
        const ext = (f.originalname && path.extname(f.originalname)) ||
          (f.mimetype && '.' + f.mimetype.split('/')[1]) || '.jpg';
        const key = `helpry/${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
        const blob = await put(key, f.buffer, {
          access: 'public',
          contentType: f.mimetype || 'image/jpeg'
        });
        urls.push(blob.url);
      }
      return urls;
    } catch (e) {
      console.error('Vercel Blob upload failed, falling back to disk:', e.message);
    }
  }

  // local disk fallback
  try {
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    for (const f of files) {
      const ext = (f.originalname && path.extname(f.originalname)) ||
        (f.mimetype && '.' + f.mimetype.split('/')[1]) || '.jpg';
      const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
      fs.writeFileSync(path.join(UPLOAD_DIR, name), f.buffer);
      urls.push(`/uploads/${name}`);
    }
    return urls;
  } catch (e) {
    console.error('Disk upload failed, falling back to data URLs:', e.message);
  }

  // data-url last resort
  for (const f of files) {
    urls.push(`data:${f.mimetype || 'image/jpeg'};base64,${f.buffer.toString('base64')}`);
  }
  return urls;
}

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
// cookie parsing (lightweight, no extra dep)
app.use((req, res, next) => {
  const raw = req.headers.cookie;
  req.cookies = {};
  if (raw) {
    raw.split(';').forEach(pair => {
      const idx = pair.indexOf('=');
      if (idx > -1) {
        const k = pair.slice(0, idx).trim();
        const v = pair.slice(idx + 1).trim();
        try { req.cookies[k] = decodeURIComponent(v); } catch (e) { req.cookies[k] = v; }
      }
    });
  }
  next();
});
app.use(express.static(PUBLIC_DIR));

app.get('/health', (req, res) => {
  res.json({ ok: true, status: 'running', port: PORT, storage: store.isUsingKV() ? 'vercel-upstash' : (store.isUsingKVClassic() ? 'vercel-kv' : 'file') });
});

// --- Admin auth endpoints -------------------------------------------------
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ success: false, error: 'Invalid password' });
  }
  const token = makeToken();
  res.setHeader('Set-Cookie',
    `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
  res.json({ success: true });
});

app.post('/api/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ success: true });
});

// Admin page — hand back the HTML shell; the client shows a login gate until authed.
app.get('/admin', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

// All admin API routes are protected.
app.get('/api/admin/clients', requireAdmin, async (req, res) => {
  const state = await store.getState();
  res.json({
    success: true,
    clients: state.clients.map(client => ({
      id: client.id,
      ref_id: client.ref_id,
      helpry_id: client.helpry_id,
      country: client.country,
      cache_lock: client.cache_lock,
      created_at: client.created_at,
      messages: listClientMessages(client)
    }))
  });
});

app.post('/api/admin/reply', requireAdmin, async (req, res) => {
  const { client_id, message } = req.body || {};

  if (!client_id) {
    return res.status(400).json({ success: false, error: 'Missing client_id' });
  }

  const state = await store.getState();
  const client = getClientById(state, client_id);
  if (!client) {
    return res.status(404).json({ success: false, error: 'Client not found' });
  }

  const msgText = (message || '').trim();
  if (!msgText) {
    return res.status(400).json({ success: false, error: 'Message is empty' });
  }

  const reply = {
    id: state.nextMessageId++,
    sender_type: 'admin',
    message: msgText,
    image_urls: [],
    created_at: new Date().toISOString()
  };

  client.messages = client.messages || [];
  client.messages.push(reply);
  await store.saveState(state);

  return res.json({
    success: true,
    message: sanitizeMessage(reply)
  });
});

app.get('/api/admin/seed-demo', requireAdmin, async (req, res) => {
  const state = await store.getState();
  if (state.clients.length > 0) {
    return res.json({ success: true, message: 'Demo already created', clients: state.clients.length });
  }

  const demoClient = {
    id: state.nextClientId++,
    ref_id: 'TW-00001',
    helpry_id: 8484,
    country: 'United States',
    cache_lock: 'demo-cache-lock-helpry-0001',
    created_at: new Date().toISOString(),
    messages: [
      {
        id: state.nextMessageId++,
        sender_type: 'client',
        message: 'Hi, I need help with my wallet.',
        image_urls: [],
        created_at: new Date().toISOString()
      }
    ]
  };

  state.clients.push(demoClient);
  await store.saveState(state);

  return res.json({ success: true, client: demoClient });
});

// --- Client (widget) endpoints (public) -----------------------------------
app.post('/api/register-client', async (req, res) => {
  const { helpry_id, country } = req.body || {};

  if (!helpry_id) {
    return res.status(400).json({ success: false, error: 'Missing helpry_id' });
  }

  const state = await store.getState();
  const client = {
    id: state.nextClientId++,
    ref_id: `TW-${String(state.nextClientId - 1).padStart(5, '0')}`,
    helpry_id: Number(helpry_id),
    country: country || 'Unknown',
    cache_lock: makeCacheLock(),
    created_at: new Date().toISOString(),
    messages: []
  };

  state.clients.push(client);
  await store.saveState(state);

  res.json({
    success: true,
    client: {
      id: client.id,
      ref_id: client.ref_id,
      helpry_id: client.helpry_id,
      country: client.country,
      cache_lock: client.cache_lock
    }
  });
});

app.post('/api/verify-cache-lock', async (req, res) => {
  const { cache_lock } = req.body || {};

  if (!cache_lock) {
    return res.status(400).json({ valid: false, reason: 'Missing cache_lock' });
  }

  const state = await store.getState();
  const client = getClientByCacheLock(state, cache_lock);
  if (!client) {
    return res.json({ valid: false, reason: 'invalid cache lock' });
  }

  return res.json({
    valid: true,
    client: {
      id: client.id,
      ref_id: client.ref_id,
      helpry_id: client.helpry_id,
      country: client.country,
      cache_lock: client.cache_lock
    }
  });
});

app.post('/api/messages/fetch', async (req, res) => {
  const { cache_lock } = req.body || {};

  if (!cache_lock) {
    return res.status(400).json({ success: false, error: 'Missing cache_lock' });
  }

  const state = await store.getState();
  const client = getClientByCacheLock(state, cache_lock);
  if (!client) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  return res.json({
    success: true,
    messages: listClientMessages(client)
  });
});

app.post('/api/messages/send', upload.array('images[]', 3), async (req, res) => {
  const { cache_lock, message } = req.body || {};

  if (!cache_lock) {
    return res.status(400).json({ success: false, error: 'Missing cache_lock' });
  }

  const state = await store.getState();
  const client = getClientByCacheLock(state, cache_lock);
  if (!client) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  const msgText = (message || '').trim();
  if (!msgText && (!req.files || req.files.length === 0)) {
    return res.status(400).json({ success: false, error: 'Empty message' });
  }

  // Persist uploaded images so they actually survive and render in the admin.
  const image_urls = await persistImages(req.files);

  const newMessage = {
    id: state.nextMessageId++,
    sender_type: 'client',
    message: msgText,
    image_urls,
    created_at: new Date().toISOString()
  };

  client.messages = client.messages || [];
  client.messages.push(newMessage);
  await store.saveState(state);

  return res.json({
    success: true,
    message: sanitizeMessage(newMessage)
  });
});

// Verify the admin session (used by the client UI gate).
app.get('/api/admin/me', (req, res) => {
  const token = req.cookies ? req.cookies[AUTH_COOKIE] : null;
  res.json({ authed: verifyToken(token) });
});

app.use((req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed for this endpoint.' });
  }

  const fallback = path.join(PUBLIC_DIR, req.path.replace(/^\//, ''));
  if (fsExistsSafe(fallback)) {
    return res.sendFile(fallback);
  }

  return res.status(404).json({ success: false, error: 'Not found' });
});

function fsExistsSafe(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch (e) {
    return false;
  }
}

// Export the app so Vercel's serverless function (api/index.js) can reuse it.
// `npm start` / `node server.js` still listens and serves locally.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Helpry local chat server is running on http://127.0.0.1:${PORT}`);
    console.log('Storage backend:', store.isUsingKV() ? 'Vercel KV' : 'local file (data/state.json)');
    console.log('Open http://127.0.0.1:5500/helpry.jp/cmupnn-trustwallet-xostfj-helpry-eohlok-trustwallet-gkqtyx.html to test the widget');
    console.log('Open http://127.0.0.1:5500/admin to manage chats');
  });
}

module.exports = app;
