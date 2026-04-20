const express = require('express');
const cors = require('cors');
const axios = require('axios');
const NodeCache = require('node-cache');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const app = express();
const PORT = process.env.PORT || 3001;

// Drive doc cache: TTL 10 minutes
const driveCache = new NodeCache({ stdTTL: 600 });

// Persistent JSON store for dismissed email IDs
// On Render.com the persistent disk is mounted at /data
const DB_PATH = process.env.NODE_ENV === 'production' ? '/data/db.json' : 'db.json';
const adapter = new FileSync(DB_PATH);
const db = low(adapter);
db.defaults({ dismissed: [], messages: [] }).write();

app.use(cors({
  origin: 'https://alyssa-james-os.netlify.app',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({ status: 'ok' });
});

// ── Dismissed emails ──────────────────────────────────────────────────────────

// GET /api/dismissed  → returns array of dismissed email IDs
app.get('/api/dismissed', (_req, res) => {
  const dismissed = db.get('dismissed').value();
  res.json({ dismissed });
});

// POST /api/dismissed  body: { id: "emailId" }
app.post('/api/dismissed', (req, res) => {
  const { id } = req.body;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'id is required' });
  }

  const already = db.get('dismissed').includes(id).value();
  if (!already) {
    db.get('dismissed').push(id).write();
  }

  res.json({ dismissed: db.get('dismissed').value() });
});

// ── Google Drive doc fetch ────────────────────────────────────────────────────

// GET /api/drive-doc?fileId=xxx
// Expects Authorization: Bearer <google_oauth_token> header from the frontend
app.get('/api/drive-doc', async (req, res) => {
  const { fileId } = req.query;
  if (!fileId) {
    return res.status(400).json({ error: 'fileId query param is required' });
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  const token = authHeader.slice(7);

  // Return cached version if available
  const cacheKey = `drive:${fileId}`;
  const cached = driveCache.get(cacheKey);
  if (cached) {
    return res.json({ text: cached, fromCache: true });
  }

  try {
    // Export Google Doc as plain text via Drive API
    const response = await axios.get(
      `https://www.googleapis.com/drive/v3/files/${fileId}/export`,
      {
        params: { mimeType: 'text/plain' },
        headers: { Authorization: `Bearer ${token}` },
        responseType: 'text',
      }
    );

    driveCache.set(cacheKey, response.data);
    res.json({ text: response.data, fromCache: false });
  } catch (err) {
    const status = err.response?.status || 500;
    const message = err.response?.data?.error?.message || err.message;
    res.status(status).json({ error: message });
  }
});

// ── iMessage ingest ───────────────────────────────────────────────────────────

// GET /api/messages  → returns all stored messages, newest first
app.get('/api/messages', (_req, res) => {
  const messages = db.get('messages').value();
  res.json({ messages: [...messages].reverse() });
});

// POST /api/messages  body: { sender, body, timestamp }
// Called by imessage-watcher.js running locally on your Mac
app.post('/api/messages', (req, res) => {
  const { sender, body, timestamp } = req.body;
  if (!sender || !body || !timestamp) {
    return res.status(400).json({ error: 'sender, body, and timestamp are required' });
  }

  const message = { id: Date.now().toString(), sender, body, timestamp };
  db.get('messages').push(message).write();
  res.status(201).json({ message });
});

// ── Gmail proxy (optional convenience) ───────────────────────────────────────
// Forwards Gmail API requests so the frontend doesn't need its own fetch logic.
// GET /api/gmail/messages?q=...&maxResults=...
app.get('/api/gmail/messages', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  const token = authHeader.slice(7);

  try {
    const response = await axios.get(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages',
      {
        params: req.query,
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    const message = err.response?.data?.error?.message || err.message;
    res.status(status).json({ error: message });
  }
});

// GET /api/gmail/messages/:id
app.get('/api/gmail/messages/:id', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  const token = authHeader.slice(7);

  try {
    const response = await axios.get(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${req.params.id}`,
      {
        params: req.query,
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    const message = err.response?.data?.error?.message || err.message;
    res.status(status).json({ error: message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`alyssa-os-backend running on port ${PORT}`);
});
