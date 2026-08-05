// Ops one-shot: name the senders on already-stored messages, then queue a
// brief for every enabled Group that has messages in the window. The running
// server's own intervals summarize and deliver — this only enqueues.
//
// The backfill exists because sender_name shipped after these messages were
// stored, and the raw webhook payload in ingest_events still carries push_name.
// It fills NULLs only, so it can be re-run and never overwrites a live value.
//
// Usage: node scripts/brief-now.ts [hours=24]
import { loadConfig } from "../src/config.ts";
import { createPool } from "../src/db.ts";

const hours = Number(process.argv[2] ?? 24);
if (!Number.isFinite(hours) || hours <= 0) throw new Error("hours must be a positive number");
const pool = createPool(loadConfig().databaseUrl);

// Matched on (session, external message id) — the same pair that makes a
// message unique — so a replayed id under another session can't rename anyone.
const filled = await pool.query(
  `UPDATE messages m
   SET sender_name = e.push_name
   FROM (
     SELECT DISTINCT ON (ie.payload->>'session', ie.payload->'payload'->>'id')
            ie.payload->>'session'                AS session_ext_id,
            ie.payload->'payload'->>'id'          AS external_id,
            ie.payload->'payload'->>'push_name'   AS push_name
     FROM ingest_events ie
     WHERE ie.payload->>'event' = 'message'
       AND coalesce(ie.payload->'payload'->>'push_name', '') <> ''
     ORDER BY ie.payload->>'session', ie.payload->'payload'->>'id', ie.id DESC
   ) e
   JOIN whatsapp_sessions ws ON ws.external_session_id = e.session_ext_id
   WHERE m.sender_name IS NULL
     AND m.session_id = ws.id
     AND m.external_id = e.external_id`,
);
console.log(`sender_name backfilled: ${filled.rowCount}`);

const windowStart = new Date(Date.now() - hours * 3600_000);
const groups = await pool.query(
  `SELECT g.id, g.name, coalesce(s.language, 'en') AS language
   FROM groups g
   LEFT JOIN summary_schedules s ON s.group_id = g.id
   WHERE g.enabled
     AND EXISTS (SELECT 1 FROM messages m
                 WHERE m.group_id = g.id AND NOT m.from_me AND m.sent_at > $1)`,
  [windowStart],
);

for (const g of groups.rows) {
  await pool.query(
    `INSERT INTO summary_jobs (group_id, language, window_start, window_end)
     VALUES ($1, $2, $3, now())`,
    [g.id, g.language, windowStart],
  );
  console.log(`queued: ${g.name ?? g.id}`);
}
console.log(`jobs queued: ${groups.rowCount} (window ${hours}h)`);
await pool.end();
