import type pg from "pg";
import type { GatewayPort } from "./gateway/port.ts";
import type { Config } from "./config.ts";
import { encrypt } from "./crypto.ts";
import { accountKey } from "./accounts.ts";
import { closeGap, openGap, processingBlock } from "./block.ts";

// Drain the durable queue: pick pending events (locked so concurrent/​restarted
// consumers don't double-process), normalize via the gateway port, encrypt the
// body, and store the message idempotently. Each event is its own transaction so
// one bad event can't wedge the queue. Returns the number of rows stored.
//
// Durability: events are already committed to ingest_events by the time this
// runs, so a crash/restart mid-drain simply resumes from the remaining pending
// rows — nothing is lost.
export async function drainQueue(
  pool: pg.Pool,
  gateway: GatewayPort,
  config: Config,
): Promise<number> {
  let stored = 0;
  for (;;) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `SELECT id, payload FROM ingest_events
         WHERE status = 'pending'
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
      );
      if (rows.length === 0) {
        await client.query("COMMIT");
        break;
      }
      const row = rows[0];
      const didStore = await processEvent(client, gateway, config, row.payload);
      if (didStore) stored++;
      await client.query(
        `UPDATE ingest_events SET status = $2, processed_at = now() WHERE id = $1`,
        [row.id, didStore ? "done" : "skipped"],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  return stored;
}

async function processEvent(
  client: pg.PoolClient,
  gateway: GatewayPort,
  config: Config,
  payload: unknown,
): Promise<boolean> {
  const evt = gateway.parse(payload);
  if (evt.type !== "message") return false;

  // Loop-prevention mirror of the ingress guard (ticket 7): a from_me echo
  // already queued before the guard shipped must be skipped here too.
  if (evt.fromMe) return false;

  // Resolve session -> owning user (tenant). Unknown session => skip: we can't
  // attribute the message to a tenant, and unattributed data must not be stored.
  const session = await client.query(
    `SELECT id, user_id FROM whatsapp_sessions WHERE external_session_id = $1`,
    [evt.sessionExternalId],
  );
  if (session.rows.length === 0) return false;
  const { id: sessionId, user_id: userId } = session.rows[0];

  // Store-time consent guard: ingress already drops disabled groups, but an
  // event enqueued while enabled can still be pending when the user disables —
  // "disable stops new messages immediately" means it must be skipped here too.
  const group = await client.query(
    `SELECT id, enabled FROM groups WHERE session_id = $1 AND external_jid = $2`,
    [sessionId, evt.groupJid],
  );
  if (group.rows.length === 0 || !group.rows[0].enabled) return false;
  const groupId = group.rows[0].id;

  // Processing Block (ticket 17): the store-time mirror of the ingress check —
  // "a block stops processing immediately" means events queued before the block
  // opened are skipped here too. Over the daily message cap a coverage gap
  // opens, so any brief overlapping the capped window is flagged incomplete
  // rather than silently truncated; the first under-cap store closes it.
  const block = await processingBlock(client, userId, { groupId, stage: "ingest" });
  if (block) {
    if (block.reason === "over_daily_messages") await openGap(client, sessionId, "plan_limit");
    return false;
  }
  await closeGap(client, sessionId, "plan_limit");

  const ciphertext = encrypt(evt.text, await accountKey(client, config, userId));

  // Idempotent store: a replayed event that slipped past the ingress dedup still
  // cannot create a second row. Expiry is stamped at store time from the owning
  // user's current retention setting (ticket 4).
  const res = await client.query(
    `INSERT INTO messages
       (user_id, session_id, group_id, external_id, sender_ref, sent_at, from_me, body_ciphertext, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
             now() + make_interval(days => (SELECT retention_days FROM users WHERE id = $1)))
     ON CONFLICT (session_id, external_id) DO NOTHING`,
    [userId, sessionId, groupId, evt.externalMessageId, evt.senderRef, evt.sentAt, evt.fromMe, ciphertext],
  );
  return (res.rowCount ?? 0) > 0;
}
