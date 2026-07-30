import type pg from "pg";

// Bump when the attestation wording shown to the user changes. Enabling
// requires the client to echo the current version, proving the user saw the
// text that is actually recorded in the audit trail.
export const ATTESTATION_VERSION = "2026-07-30";

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

export type ToggleResult = "ok" | "not_found" | "attestation_required";

// Enable requires a matching self-attestation; the flag flip and the audit
// record commit atomically so an enabled group can never lack its consent record.
export async function enableGroup(
  pool: pg.Pool,
  userId: string,
  groupId: string,
  attestationVersion: unknown,
): Promise<ToggleResult> {
  if (attestationVersion !== ATTESTATION_VERSION) return "attestation_required";
  return setEnabled(pool, userId, groupId, true, ATTESTATION_VERSION);
}

export function disableGroup(
  pool: pg.Pool,
  userId: string,
  groupId: string,
): Promise<ToggleResult> {
  return setEnabled(pool, userId, groupId, false, null);
}

async function setEnabled(
  pool: pg.Pool,
  userId: string,
  groupId: string,
  enabled: boolean,
  attestationVersion: string | null,
): Promise<ToggleResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // The join to the user's sessions is the tenant boundary: another user's
    // group id behaves exactly like a nonexistent one.
    const res = await client.query(
      `UPDATE groups g SET enabled = $3
       FROM whatsapp_sessions s
       WHERE g.id = $2 AND g.session_id = s.id AND s.user_id = $1
       RETURNING g.id`,
      [userId, groupId, enabled],
    );
    if (res.rowCount === 0) {
      await client.query("ROLLBACK");
      return "not_found";
    }
    await client.query(
      `INSERT INTO consent_records (user_id, group_id, action, attestation_version)
       VALUES ($1, $2, $3, $4)`,
      [userId, groupId, enabled ? "enabled" : "disabled", attestationVersion],
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

export type ConsentRecord = {
  id: string;
  group_id: string;
  action: string;
  attestation_version: string | null;
  created_at: string;
};

export async function listConsentRecords(
  pool: pg.Pool,
  userId: string,
): Promise<ConsentRecord[]> {
  const { rows } = await pool.query(
    `SELECT id, group_id, action, attestation_version, created_at
     FROM consent_records
     WHERE user_id = $1
     ORDER BY created_at, id`,
    [userId],
  );
  return rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() }));
}
