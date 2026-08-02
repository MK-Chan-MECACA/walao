import type pg from "pg";
import { PLANS, getPlan } from "./billing.ts";
import { ATTESTATION_TEXTS, recordAttestation } from "./attestations.ts";
import type { GatewayPort } from "./gateway/port.ts";

// Enabling requires the client to echo the current version, proving the user
// saw the wording — which lives in ATTESTATION_TEXTS and is copied onto the
// Attestation row (§21). Bump the version there when the wording changes.
export const ATTESTATION_VERSION = ATTESTATION_TEXTS.group_responsibility.version;

export const DISCLOSURE_TEMPLATE = {
  version: "2026-07-30",
  text:
    "Heads-up 👋 I use WALAO to summarize this group's messages into private notes for myself. " +
    "Summaries are visible only to me and raw messages auto-expire. Happy to share details if anyone wants them.\n" +
    "提醒一下 👋 我使用 WALAO 为自己整理这个群的消息摘要，摘要仅我自己可见，原始消息会自动过期。有疑问欢迎问我。",
};

export type GroupView = {
  id: string;
  external_jid: string;
  name: string | null;
  enabled: boolean;
};

// Groups are tenant-scoped through the session's owning user.
export async function listGroups(pool: pg.Pool, userId: string): Promise<GroupView[]> {
  const { rows } = await pool.query(
    `SELECT g.id, g.external_jid, g.name, g.enabled
     FROM groups g
     JOIN whatsapp_sessions s ON s.id = g.session_id
     WHERE s.user_id = $1
     ORDER BY g.created_at`,
    [userId],
  );
  return rows;
}

export type ToggleResult = "ok" | "not_found" | "attestation_required" | "plan_limit";

// Enable requires a matching self-attestation; the flag flip and the audit
// record commit atomically so an enabled group can never lack its consent record.
export async function enableGroup(
  pool: pg.Pool,
  userId: string,
  groupId: string,
  attestationVersion: unknown,
): Promise<ToggleResult> {
  if (attestationVersion !== ATTESTATION_VERSION) return "attestation_required";
  return setEnabled(pool, userId, groupId, true);
}

export function disableGroup(
  pool: pg.Pool,
  userId: string,
  groupId: string,
): Promise<ToggleResult> {
  return setEnabled(pool, userId, groupId, false);
}

async function setEnabled(
  pool: pg.Pool,
  userId: string,
  groupId: string,
  enabled: boolean,
): Promise<ToggleResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (enabled) {
      // Plan cap on enabled groups (spec §53). FOR UPDATE on the user row
      // serializes concurrent enables so the cap can't be raced past. The
      // target group is excluded so re-attesting an already-enabled group
      // at the cap still works.
      await client.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [userId]);
      const cap = PLANS[await getPlan(client, userId)].max_groups;
      const n = await client.query(
        `SELECT count(*)::int AS n FROM groups g
         JOIN whatsapp_sessions s ON s.id = g.session_id
         WHERE s.user_id = $1 AND g.enabled AND g.id <> $2`,
        [userId, groupId],
      );
      if (n.rows[0].n >= cap) {
        await client.query("ROLLBACK");
        return "plan_limit";
      }
    }
    // The join to the user's sessions is the tenant boundary: another user's
    // group id behaves exactly like a nonexistent one.
    const res = await client.query(
      // enabled_at is the tiebreak when an account goes over the group cap: the
      // N enabled longest keep processing (spec §240). Re-attesting an already
      // enabled group keeps its original moment.
      `UPDATE groups g SET enabled = $3,
              enabled_at = CASE WHEN $3 THEN COALESCE(g.enabled_at, now()) ELSE NULL END
       FROM whatsapp_sessions s
       WHERE g.id = $2 AND g.session_id = s.id AND s.user_id = $1
       RETURNING g.id`,
      [userId, groupId, enabled],
    );
    if (res.rowCount === 0) {
      await client.query("ROLLBACK");
      return "not_found";
    }
    if (!enabled) {
      // Spec §22: disabling stops processing immediately. Ingestion and the
      // consumer already drop events for a disabled group, but a summary job
      // queued while it was on would still summarise afterwards — so it is
      // cancelled in the same transaction as the flag flip and the audit row.
      await client.query(
        `UPDATE summary_jobs SET status = 'cancelled' WHERE group_id = $1 AND status = 'pending'`,
        [groupId],
      );
    }
    await recordAttestation(
      client,
      userId,
      enabled ? "group_responsibility" : "group_disabled",
      groupId,
    );
    await client.query("COMMIT");
    return "ok";
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Backfill group titles. Discovery registers a group the first time a message
// arrives, but providers may not carry the chat name on message events (WAAPI
// does not), so those rows land unnamed. One gateway call per session that
// still has an unnamed group; sessions with every name filled cost nothing.
// Metadata only — no message content is read or written here.
export async function backfillGroupNames(pool: pg.Pool, gateway: GatewayPort): Promise<number> {
  const { rows: sessions } = await pool.query(
    `SELECT DISTINCT s.external_session_id
     FROM groups g
     JOIN whatsapp_sessions s ON s.id = g.session_id
     WHERE g.name IS NULL AND s.status = 'connected'`,
  );

  let named = 0;
  for (const { external_session_id: sessionExternalId } of sessions) {
    let groups;
    try {
      groups = await gateway.listGroups(sessionExternalId);
    } catch {
      continue; // gateway down or session gone: the next pass retries
    }
    for (const g of groups) {
      if (!g.name) continue;
      // Only ever fills a NULL — a name already stored is never overwritten.
      const res = await pool.query(
        `UPDATE groups SET name = $3
         FROM whatsapp_sessions s
         WHERE groups.session_id = s.id
           AND s.external_session_id = $1
           AND groups.external_jid = $2
           AND groups.name IS NULL`,
        [sessionExternalId, g.jid, g.name],
      );
      named += res.rowCount ?? 0;
    }
  }
  return named;
}
