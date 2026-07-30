import type pg from "pg";
import type { GatewayPort } from "./gateway/port.ts";
import type { Config } from "./config.ts";
import { encrypt } from "./crypto.ts";

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

  // Resolve session -> owning user (tenant). Unknown session => skip: we can't
  // attribute the message to a tenant, and unattributed data must not be stored.
  const session = await client.query(
    `SELECT id, user_id FROM whatsapp_sessions WHERE external_session_id = $1`,
    [evt.sessionExternalId],
  );
  if (session.rows.length === 0) return false;
  const { id: sessionId, user_id: userId } = session.rows[0];

  // Upsert the group within the session.
  await client.query(
    `INSERT INTO groups (session_id, external_jid, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (session_id, external_jid) DO NOTHING`,
    [sessionId, evt.groupJid, evt.groupName],
  );
  const group = await client.query(
    `SELECT id FROM groups WHERE session_id = $1 AND external_jid = $2`,
    [sessionId, evt.groupJid],
  );
  const groupId = group.rows[0].id;

  const ciphertext = encrypt(evt.text, config.encKey);

  // Idempotent store: a replayed event that slipped past the ingress dedup still
  // cannot create a second row.
  const res = await client.query(
    `INSERT INTO messages
       (user_id, session_id, group_id, external_id, sender_ref, sent_at, body_ciphertext)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (session_id, external_id) DO NOTHING`,
    [userId, sessionId, groupId, evt.externalMessageId, evt.senderRef, evt.sentAt, ciphertext],
  );
  return (res.rowCount ?? 0) > 0;
}
