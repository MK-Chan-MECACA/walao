import type pg from "pg";
import type { GatewayPort } from "./gateway/port.ts";
import type { Config } from "./config.ts";
import { listMessages } from "./api.ts";
import { forgetAccountKey } from "./accounts.ts";

// Ticket 10: pause, export, delete. Postgres is the system's only store — there
// are no caches, search indexes, or managed backups — so "deleted everywhere"
// means deleted from every table, including the raw webhook payloads still
// sitting in ingest_events.

export type PrivacyAction = "pause" | "resume" | "export" | "delete_group" | "delete_account";

// Every privacy action is provable from this row alone: actor, action,
// timestamp — never message content. No users FK, so it survives account
// deletion.
async function audit(
  db: pg.Pool | pg.PoolClient,
  userId: string,
  action: PrivacyAction,
  detail: string | null = null,
): Promise<void> {
  await db.query(`INSERT INTO privacy_audit (user_id, action, detail) VALUES ($1, $2, $3)`, [
    userId,
    action,
    detail,
  ]);
}

// Defined pause behavior (ticket 10 leaves it open): pause halts EVERYTHING.
// Incoming events are dropped before any write (ingress) and already-queued
// ones are dropped at drain (same permanent-drop semantics as disable and
// disconnect — privacy-first: paused means not stored). Pending summary jobs
// and undelivered summaries merely wait: scheduler/summarizer/delivery skip
// paused users and resume where they left off.
// A pause is lost coverage (spec §31): it opens a coverage gap so that summaries
// spanning it are flagged incomplete, exactly like halt and disconnect. Resume
// closes the gaps the pause opened and nobody else's.
export async function setPaused(pool: pg.Pool, userId: string, paused: boolean): Promise<void> {
  await pool.query(`UPDATE users SET paused = $2 WHERE id = $1`, [userId, paused]);
  if (paused) {
    await pool.query(
      `INSERT INTO coverage_gaps (session_id, reason)
       SELECT s.id, 'paused' FROM whatsapp_sessions s
       WHERE s.user_id = $1 AND NOT EXISTS
         (SELECT 1 FROM coverage_gaps WHERE session_id = s.id AND ended_at IS NULL)`,
      [userId],
    );
  } else {
    await pool.query(
      `UPDATE coverage_gaps SET ended_at = now()
       WHERE reason = 'paused' AND ended_at IS NULL
         AND session_id IN (SELECT id FROM whatsapp_sessions WHERE user_id = $1)`,
      [userId],
    );
  }
  await audit(pool, userId, paused ? "pause" : "resume");
}

// Portable export: everything the spec names — raw messages still within
// retention (decrypted; ciphertext is useless outside this system), summaries,
// and settings (retention, pause state, groups with consent + schedules).
export async function exportData(
  pool: pg.Pool,
  config: Config,
  userId: string,
): Promise<Record<string, unknown>> {
  const [messages, summaries, user, groups, memories, recipients] = await Promise.all([
    listMessages(pool, config, userId),
    pool.query(
      `SELECT id, group_id, language, window_start, window_end, payload, created_at
       FROM summaries WHERE user_id = $1 ORDER BY created_at`,
      [userId],
    ),
    pool.query(`SELECT retention_days, paused FROM users WHERE id = $1`, [userId]),
    pool.query(
      `SELECT g.external_jid, g.name, g.enabled, sc.local_time, sc.timezone, sc.language
       FROM groups g
       JOIN whatsapp_sessions s ON s.id = g.session_id
       LEFT JOIN summary_schedules sc ON sc.group_id = g.id
       WHERE s.user_id = $1 ORDER BY g.created_at`,
      [userId],
    ),
    pool.query(
      `SELECT id, content, source_message_ids, group_jid, summary_id, confirmed_by,
              created_at, last_used_at
       FROM memories WHERE user_id = $1 ORDER BY created_at`,
      [userId],
    ),
    pool.query(
      `SELECT recipient_jid, status, created_at, confirmed_at
       FROM outbound_recipients WHERE user_id = $1 ORDER BY created_at`,
      [userId],
    ),
  ]);
  await audit(pool, userId, "export");
  return {
    exported_at: new Date().toISOString(),
    messages,
    summaries: summaries.rows,
    memories: memories.rows,
    outbound_recipients: recipients.rows,
    settings: {
      retention_days: user.rows[0].retention_days,
      paused: user.rows[0].paused,
      groups: groups.rows,
    },
  };
}

// Group-level delete: the group row cascades messages, summaries (and their
// item states), schedules, jobs, and consent records. What cascades can't
// reach is handled explicitly: reminders and memories (summary_id is SET NULL
// by design so their copied text would survive) and queued raw webhook payloads.
export async function deleteGroupData(
  pool: pg.Pool,
  gateway: GatewayPort,
  userId: string,
  groupId: string,
): Promise<"ok" | "not_found"> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT g.external_jid, s.external_session_id
       FROM groups g JOIN whatsapp_sessions s ON s.id = g.session_id
       WHERE g.id = $2 AND s.user_id = $1`,
      [userId, groupId],
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return "not_found";
    }
    const { external_jid: jid, external_session_id: sessionExternalId } = rows[0];

    // Confirmed reminders copied their text out of this group's summaries —
    // derived data of the group, so it goes too.
    await client.query(
      `DELETE FROM reminders WHERE summary_id IN (SELECT id FROM summaries WHERE group_id = $1)`,
      [groupId],
    );
    // Same rule for confirmed memories: their content was copied out of this
    // group's summaries, so a group delete takes them too (SET NULL would
    // otherwise leave the copied text behind).
    await client.query(
      `DELETE FROM memories WHERE summary_id IN (SELECT id FROM summaries WHERE group_id = $1)`,
      [groupId],
    );
    await deleteQueuedEvents(client, gateway, sessionExternalId, jid);
    await client.query(`DELETE FROM groups WHERE id = $1`, [groupId]);
    await audit(client, userId, "delete_group", jid);
    await client.query("COMMIT");
    return "ok";
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Whole-account delete: the users cascade takes sessions, groups, messages,
// summaries, item states, reminders, consent records, schedules, jobs, and
// coverage gaps. ingest_events has no user FK (it's pre-attribution by
// design), so its rows are deleted explicitly first. The audit row is the only
// thing that remains, and it carries no content.
export async function deleteAccount(pool: pg.Pool, userId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM ingest_events WHERE session_external_id IN
         (SELECT external_session_id FROM whatsapp_sessions WHERE user_id = $1)`,
      [userId],
    );
    await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await audit(client, userId, "delete_account");
    await client.query("COMMIT");
    // The wrapped key went with the row; drop the unwrapped copy this process
    // is holding, or crypto-shredding would only start at the next restart.
    forgetAccountKey(userId);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Queued webhook payloads ARE raw message JSON; a delete that skipped them
// would leave bodies in primary storage. The queue is keyed by session only,
// so the group filter parses each payload through the gateway port.
// ponytail: O(n) scan of the session's queue rows; add a group column to
// ingest_events if queues ever get deep.
async function deleteQueuedEvents(
  client: pg.PoolClient,
  gateway: GatewayPort,
  sessionExternalId: string,
  groupJid: string,
): Promise<void> {
  const { rows } = await client.query(
    `SELECT id, payload FROM ingest_events WHERE session_external_id = $1`,
    [sessionExternalId],
  );
  const ids = rows
    .filter((r) => {
      try {
        const evt = gateway.parse(r.payload);
        return evt.type === "message" && evt.groupJid === groupJid;
      } catch {
        return false;
      }
    })
    .map((r) => r.id);
  if (ids.length > 0) {
    await client.query(`DELETE FROM ingest_events WHERE id = ANY($1)`, [ids]);
  }
}
