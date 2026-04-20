const Database = require('better-sqlite3');
const axios = require('axios');
const os = require('os');
const path = require('path');

const CHAT_DB = path.join(os.homedir(), 'Library/Messages/chat.db');
const BACKEND_URL = 'https://alyssa-os-backend-production.up.railway.app/api/messages';
const POLL_INTERVAL_MS = 30_000;

// Open the iMessage DB in read-only mode so we never corrupt it
const db = new Database(CHAT_DB, { readonly: true, fileMustExist: true });

// Track the highest ROWID we've already processed so we only POST new rows
let lastSeenRowId = getLatestRowId();

function getLatestRowId() {
  const row = db.prepare('SELECT MAX(ROWID) AS maxId FROM message').get();
  return row?.maxId ?? 0;
}

// Returns a display name for a handle (phone / email) by checking the
// address book tables that iMessage exposes inside chat.db when available.
function resolveSender(handleId) {
  try {
    const row = db
      .prepare('SELECT id FROM handle WHERE ROWID = ?')
      .get(handleId);
    return row?.id ?? 'Unknown';
  } catch {
    return 'Unknown';
  }
}

async function poll() {
  try {
    // Only fetch incoming messages (is_from_me = 0) newer than last seen
    const rows = db
      .prepare(
        `SELECT
           m.ROWID,
           m.handle_id,
           m.text,
           m.date
         FROM message m
         WHERE m.ROWID > ?
           AND m.is_from_me = 0
           AND m.text IS NOT NULL
         ORDER BY m.ROWID ASC`
      )
      .all(lastSeenRowId);

    for (const row of rows) {
      const sender = resolveSender(row.handle_id);

      // iMessage stores dates as nanoseconds since 2001-01-01 (Apple epoch)
      const appleEpochOffset = 978307200; // seconds between Unix epoch and Apple epoch
      const timestampMs = (row.date / 1e9 + appleEpochOffset) * 1000;
      const timestamp = new Date(timestampMs).toISOString();

      try {
        await axios.post(BACKEND_URL, {
          sender,
          body: row.text,
          timestamp,
        });
        console.log(`[imessage-watcher] posted message ROWID=${row.ROWID} from ${sender}`);
      } catch (postErr) {
        console.error(`[imessage-watcher] failed to POST ROWID=${row.ROWID}:`, postErr.message);
      }

      lastSeenRowId = row.ROWID;
    }
  } catch (err) {
    console.error('[imessage-watcher] poll error:', err.message);
  }
}

console.log(`[imessage-watcher] starting — polling every ${POLL_INTERVAL_MS / 1000}s`);
console.log(`[imessage-watcher] last seen ROWID: ${lastSeenRowId}`);

// Run immediately on start, then on interval
poll();
setInterval(poll, POLL_INTERVAL_MS);
