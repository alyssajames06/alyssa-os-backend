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
const TEMP_DIR = path.join(os.tmpdir(), 'imessage-watcher');

let lastSeenRowId = 0;

// iMessage runs SQLite in WAL (Write-Ahead Log) mode. New messages land in
// chat.db-wal first and are only merged into chat.db during a checkpoint —
// which may never happen while Messages.app is open. If we only read chat.db,
// we see a stale snapshot and miss every new message.
//
// Fix: copy chat.db + chat.db-wal + chat.db-shm to a temp directory before
// opening. SQLite will replay the WAL automatically when it opens the copy,
// giving us a fully up-to-date view without touching the live files.
function loadDb() {
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const tmpDb = path.join(TEMP_DIR, 'chat.db');
  fs.copyFileSync(CHAT_DB, tmpDb);

  // Copy WAL and SHM so SQLite can replay uncommitted pages into our snapshot.
  // If either doesn't exist, remove any stale copy so SQLite isn't confused.
  for (const ext of ['wal', 'shm']) {
    const src = `${CHAT_DB}-${ext}`;
    const dst = `${tmpDb}-${ext}`;
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
    } else {
      try { fs.unlinkSync(dst); } catch {}
    }
  }

  const fileBuffer = fs.readFileSync(tmpDb);
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
// Every failure path returns the fallback so poll() is never interrupted.
function resolveContact(handleId) {
  const fallback = { sender: handleId, name: null };
  if (!contacts) return fallback;

  let allContacts;
  try {
    allContacts = contacts.getAllContacts();
  } catch (err) {
    console.warn('[imessage-watcher] contacts.getAllContacts() threw:', err.message);
    return fallback;
  }

  // Guard against null / non-iterable return values
  if (!Array.isArray(allContacts)) {
    console.warn('[imessage-watcher] contacts.getAllContacts() returned non-array:', typeof allContacts);
    return fallback;
  }

  try {
    const needle = normalisePhone(handleId);
    const isPhone = /^\d{7,}$/.test(needle);

    for (const contact of allContacts) {
      try {
        if (isPhone) {
          const phones = contact.phoneNumbers ?? [];
          const match = phones.some(p => normalisePhone(p.value) === needle);
          if (match) {
            const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim();
            return { sender: handleId, name: name || null };
          }
        } else {
          const emails = contact.emailAddresses ?? [];
          const match = emails.some(e => e.value?.toLowerCase() === handleId.toLowerCase());
          if (match) {
            const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim();
            return { sender: handleId, name: name || null };
          }
        }
      } catch (contactErr) {
        // Skip malformed contact entry, keep scanning
        console.warn('[imessage-watcher] skipping malformed contact entry:', contactErr.message);
      }
    }
  } catch (err) {
    console.warn('[imessage-watcher] contact scan error:', err.message);
  }

  return fallback;
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
  console.log(`[imessage-watcher] poll at ${new Date().toISOString()} — last ROWID: ${lastSeenRowId}`);
  let db;
  try {
    db = loadDb();

    // Sanity-check: log the current MAX(ROWID) in the snapshot we loaded.
    // If this stays the same across polls while you know new messages arrived,
    // the WAL copy is still not working.
    const maxRow = queryOne(db, 'SELECT MAX(ROWID) AS maxId FROM message');
    console.log(`[imessage-watcher] DB snapshot MAX(ROWID): ${maxRow?.maxId ?? 'null'}`);

    const SQL_QUERY = `
      SELECT m.ROWID, m.handle_id, m.text, m.date, m.is_from_me
      FROM message m
      WHERE m.ROWID > ?
        AND m.is_from_me = 0
        AND m.text IS NOT NULL
      ORDER BY m.ROWID ASC`;

    console.log(`[imessage-watcher] running query with ROWID > ${lastSeenRowId}`);
    const rows = queryAll(db, SQL_QUERY, [lastSeenRowId]);
    console.log(`[imessage-watcher] query returned ${rows.length} row(s)`);

    // Also log the 3 most recent messages regardless of is_from_me, so we can
    // see what's actually in the DB and confirm the filter isn't the problem.
    const recent = queryAll(
      db,
      `SELECT ROWID, handle_id, is_from_me, text
       FROM message
       ORDER BY ROWID DESC
       LIMIT 3`
    );
    console.log('[imessage-watcher] 3 most recent DB rows:', JSON.stringify(recent));

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

const ONCE = process.argv.includes('--once');

// sql.js requires async init before anything else
let SQL;
initSqlJs().then(async (SqlJs) => {
  SQL = SqlJs;

  // Seed lastSeenRowId from current DB state so we only post messages that
  // arrive after this process started (or, in --once mode, since last run).
  const db = loadDb();
  const row = queryOne(db, 'SELECT MAX(ROWID) AS maxId FROM message');
  db.close();
  lastSeenRowId = row?.maxId ?? 0;

  if (ONCE) {
    console.log(`[imessage-watcher] --once mode — last ROWID: ${lastSeenRowId}`);
    await poll();
    process.exit(0);
  } else {
    console.log(`[imessage-watcher] starting — polling every ${POLL_INTERVAL_MS / 1000}s`);
    console.log(`[imessage-watcher] last seen ROWID: ${lastSeenRowId}`);
    poll();
    setInterval(poll, POLL_INTERVAL_MS);
  }
});
