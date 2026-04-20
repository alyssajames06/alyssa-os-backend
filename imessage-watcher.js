const initSqlJs = require('sql.js');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');

// node-mac-contacts requires macOS Contacts permission on first run
let contacts;
try {
  contacts = require('node-mac-contacts');
} catch (e) {
  console.warn('[imessage-watcher] node-mac-contacts not available — names will not be resolved:', e.message);
}

const CHAT_DB = path.join(os.homedir(), 'Library/Messages/chat.db');
const BACKEND_URL = 'https://alyssa-os-backend-production.up.railway.app/api/messages';
const POLL_INTERVAL_MS = 30_000;

let lastSeenRowId = 0;

// sql.js loads the entire DB file into memory — we reload it each poll so we
// always see the latest writes that iMessage has flushed to disk.
function loadDb() {
  const fileBuffer = fs.readFileSync(CHAT_DB);
  return new SQL.Database(fileBuffer);
}

function queryOne(db, sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function queryAll(db, sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// Normalise a phone number to digits only for fuzzy matching against contacts
function normalisePhone(raw) {
  return (raw ?? '').replace(/\D/g, '');
}

// Look up a contact name for a given handle id (phone number or email).
// Returns { sender, name } — sender is always the raw id, name is the resolved
// display name or null if not found.
function resolveContact(handleId) {
  if (!contacts) return { sender: handleId, name: null };

  try {
    const allContacts = contacts.getAllContacts() ?? [];
    const needle = normalisePhone(handleId);
    const isPhone = /^\d{7,}$/.test(needle);

    for (const contact of allContacts) {
      if (isPhone) {
        const phones = contact.phoneNumbers ?? [];
        const match = phones.some(p => normalisePhone(p.value) === needle);
        if (match) {
          const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim();
          return { sender: handleId, name: name || null };
        }
      } else {
        // email-based handle
        const emails = contact.emailAddresses ?? [];
        const match = emails.some(e => e.value?.toLowerCase() === handleId.toLowerCase());
        if (match) {
          const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim();
          return { sender: handleId, name: name || null };
        }
      }
    }
  } catch (err) {
    console.warn('[imessage-watcher] contacts lookup error:', err.message);
  }

  return { sender: handleId, name: null };
}

function resolveSender(db, handleId) {
  try {
    const row = queryOne(db, 'SELECT id FROM handle WHERE ROWID = ?', [handleId]);
    return row?.id ?? 'Unknown';
  } catch {
    return 'Unknown';
  }
}

async function poll() {
  let db;
  try {
    db = loadDb();

    const rows = queryAll(
      db,
      `SELECT
         m.ROWID,
         m.handle_id,
         m.text,
         m.date
       FROM message m
       WHERE m.ROWID > ?
         AND m.is_from_me = 0
         AND m.text IS NOT NULL
       ORDER BY m.ROWID ASC`,
      [lastSeenRowId]
    );

    for (const row of rows) {
      const rawSender = resolveSender(db, row.handle_id);
      const { sender, name } = resolveContact(rawSender);

      // iMessage stores dates as nanoseconds since 2001-01-01 (Apple epoch)
      const appleEpochOffset = 978307200;
      const timestampMs = (row.date / 1e9 + appleEpochOffset) * 1000;
      const timestamp = new Date(timestampMs).toISOString();

      const payload = { sender, body: row.text, timestamp };
      if (name) payload.name = name;

      const displayName = name ?? sender;
      try {
        await axios.post(BACKEND_URL, payload);
        console.log(`[imessage-watcher] posted ROWID=${row.ROWID} from ${displayName}`);
      } catch (postErr) {
        console.error(`[imessage-watcher] failed to POST ROWID=${row.ROWID}:`, postErr.message);
      }

      lastSeenRowId = row.ROWID;
    }
  } catch (err) {
    console.error('[imessage-watcher] poll error:', err.message);
  } finally {
    db?.close();
  }
}

// sql.js requires async init before anything else
let SQL;
initSqlJs().then((SqlJs) => {
  SQL = SqlJs;

  // Seed lastSeenRowId from current DB state so we don't replay old messages
  const db = loadDb();
  const row = queryOne(db, 'SELECT MAX(ROWID) AS maxId FROM message');
  db.close();
  lastSeenRowId = row?.maxId ?? 0;

  console.log(`[imessage-watcher] starting — polling every ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`[imessage-watcher] last seen ROWID: ${lastSeenRowId}`);

  poll();
  setInterval(poll, POLL_INTERVAL_MS);
});
