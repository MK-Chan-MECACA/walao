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
  // Enabled but past the Plan's cap, so nothing from it is being read. The
  // rank test mirrors processingBlock's over_group_cap exactly (block.ts:76):
  // oldest enabled Groups keep working, the ones enabled past the cap do not.
  blocked: boolean;
  schedule: { local_time: string; timezone: string; language: string } | null;
};

// Groups are tenant-scoped through the session's owning user.
//
// A Group belongs to the Account, but the rows are keyed per Session
// (UNIQUE (session_id, external_jid)), and re-pairing mints a new Session — so
// the same WhatsApp Group can hold one row per Session the Account has ever
// had. DISTINCT ON collapses those to the row that is actually live: the
// connected Session first, then the newest. Counts are per Group rather than
// per row for the same reason, so a stale copy can never inflate the cap.
export async function listGroups(pool: pg.Pool, userId: string): Promise<GroupView[]> {
  const [{ rows }, plan] = await Promise.all([
    pool.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (g.external_jid)
                g.id, g.external_jid, g.name, g.enabled, g.created_at,
                sc.local_time, sc.timezone, sc.language,
                (SELECT count(DISTINCT o.external_jid)::int FROM groups o
                   JOIN whatsapp_sessions os ON os.id = o.session_id
                  WHERE os.user_id = $1 AND o.enabled AND o.enabled_at < g.enabled_at)
                  AS enabled_before
         FROM groups g
         JOIN whatsapp_sessions s ON s.id = g.session_id
         LEFT JOIN summary_schedules sc ON sc.group_id = g.id
         WHERE s.user_id = $1
         ORDER BY g.external_jid, (s.status = 'connected') DESC, s.created_at DESC
       ) g
       ORDER BY g.created_at`,
      [userId],
    ),
    getPlan(pool, userId),
  ]);
  return rows.map((r) => ({
    id: r.id,
    external_jid: r.external_jid,
    name: r.name,
    enabled: r.enabled,
    blocked: r.enabled && r.enabled_before >= PLANS[plan].max_groups,
    schedule: r.local_time
      ? { local_time: r.local_time, timezone: r.timezone, language: r.language }
      : null,
  }));
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

// Seed the group list from the gateway when a session reaches 'connected'.
// Message-driven discovery alone leaves a freshly paired Account with an empty
// Groups screen until someone else happens to post — and a message the user
// sends themselves is dropped as fromMe, so the list can stay empty for days.
// Rows land disabled and unenabled, exactly like discovery: this is a list of
// candidates to enable, not consent to process any of them. Metadata only.
export async function seedGroups(
  pool: pg.Pool,
  gateway: GatewayPort,
  sessionExternalId: string,
): Promise<number> {
  const groups = await gateway.listGroups(sessionExternalId);
  let added = 0;
  for (const g of groups) {
    if (!g.jid.endsWith("@g.us")) continue; // status@broadcast and DMs are not Groups
    const res = await pool.query(
      `INSERT INTO groups (session_id, external_jid, name)
       SELECT id, $2, $3 FROM whatsapp_sessions WHERE external_session_id = $1
       ON CONFLICT (session_id, external_jid) DO NOTHING`,
      [sessionExternalId, g.jid, g.name],
    );
    added += res.rowCount ?? 0;
  }
  return added;
}

// The state this Account last chose for each Group, taken from every Session
// except the one named, newest first. Shared by adoptGroups and migration 024.
const PRIOR_STATE = `
  SELECT DISTINCT ON (g.external_jid)
         g.id, g.external_jid, g.enabled, g.enabled_at
    FROM groups g
    JOIN whatsapp_sessions s ON s.id = g.session_id
   WHERE s.user_id = $1 AND g.session_id <> $2
   ORDER BY g.external_jid, g.enabled DESC, g.enabled_at DESC NULLS LAST, g.created_at DESC`;

// A Group is the Account's, not the Session's. Re-pairing mints a new Session
// and seedGroups refills it with everything disabled, which leaves the Account's
// real choices stranded on the Session it just replaced: consumer.ts looks the
// Group up by session_id, so those Groups read as enabled, still count against
// the Plan cap, and are read by nothing. Carry the choice onto the live rows and
// stand the superseded ones down, so what the screen says and what WALAO reads
// are the same thing again.
//
// Nothing is deleted: messages and summaries hang off the old rows by
// ON DELETE CASCADE, and a re-pair must not cost the Account its history.
export async function adoptGroups(pool: pg.Pool, sessionExternalId: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT id, user_id FROM whatsapp_sessions WHERE external_session_id = $1`,
      [sessionExternalId],
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return 0;
    }
    const args = [rows[0].user_id, rows[0].id];

    const adopted = await client.query(
      `WITH prior AS (${PRIOR_STATE})
       UPDATE groups g SET enabled = true, enabled_at = prior.enabled_at
         FROM prior
        WHERE g.session_id = $2 AND g.external_jid = prior.external_jid
          AND prior.enabled AND NOT g.enabled`,
      args,
    );

    // §31: the schedule is a property of the Group, so it follows the Group
    // across a re-pair rather than dying with the Session it was set on.
    await client.query(
      `WITH prior AS (${PRIOR_STATE})
       INSERT INTO summary_schedules (group_id, local_time, timezone, language)
       SELECT live.id, sc.local_time, sc.timezone, sc.language
         FROM prior
         JOIN summary_schedules sc ON sc.group_id = prior.id
         JOIN groups live ON live.session_id = $2 AND live.external_jid = prior.external_jid
       ON CONFLICT (group_id) DO NOTHING`,
      args,
    );

    // Only a Group the live Session actually carries is stood down. One that the
    // gateway did not return this time keeps its state — a Group must not be
    // silently disabled because WhatsApp omitted it from one listing.
    await client.query(
      `UPDATE groups g SET enabled = false
         FROM whatsapp_sessions s
        WHERE s.id = g.session_id AND s.user_id = $1
          AND g.session_id <> $2 AND g.enabled
          AND EXISTS (SELECT 1 FROM groups live
                       WHERE live.session_id = $2 AND live.external_jid = g.external_jid)`,
      args,
    );

    await client.query("COMMIT");
    return adopted.rowCount ?? 0;
  } catch (err) {
    await client.query("ROLLBACK");
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

    // Converge. A jid the gateway does not return (left group, or a chat it no
    // longer knows) would stay NULL forever, and this session would re-query
    // /groups on every pass — which is what WhatsApp answers with 429
    // rate-overlimit and then closes the stream over. Stamp the leftovers with
    // their jid so the pass has an end: the UI already renders
    // `name ?? external_jid`, so nothing looks different. Skipped when the
    // gateway returned nothing at all — an empty list is more likely a session
    // still warming up than proof every group is gone.
    if (groups.length > 0) {
      await pool.query(
        `UPDATE groups SET name = groups.external_jid
         FROM whatsapp_sessions s
         WHERE groups.session_id = s.id
           AND s.external_session_id = $1
           AND groups.name IS NULL
           AND groups.external_jid <> ALL($2::text[])`,
        [sessionExternalId, groups.map((g) => g.jid)],
      );
    }
  }
  return named;
}
