import type pg from "pg";
import type {
  GatewayPort,
  NormalizedStatus,
  SelfIdentity,
  SessionStatus,
} from "./gateway/port.ts";
import { isHalted } from "./halt.ts";
import { ATTESTATION_TEXTS, recordAttestation } from "./attestations.ts";
import { grantTrial } from "./billing.ts";
import { adoptGroups, seedGroups } from "./subscriptions.ts";

// Shown before pairing. POST /v1/connections must echo the current version
// (same pattern as the group attestation) so pairing cannot start unseen, and
// the wording behind that version is stored as the ban_risk Attestation (§8).
export const ONBOARDING_DISCLOSURE = ATTESTATION_TEXTS.ban_risk;

export type ConnectionView = {
  id: string;
  external_session_id: string;
  status: SessionStatus | "pending";
  status_changed_at: string;
};

function view(r: Record<string, unknown>): ConnectionView {
  return {
    id: r.id as string,
    external_session_id: r.external_session_id as string,
    status: r.status as ConnectionView["status"],
    status_changed_at: new Date(r.status_changed_at as string).toISOString(),
  };
}

export async function createConnection(
  pool: pg.Pool,
  gateway: GatewayPort,
  userId: string,
  disclosureVersion: unknown,
): Promise<"disclosure_required" | "halted" | { connection: ConnectionView; pairing_code: string }> {
  if (disclosureVersion !== ONBOARDING_DISCLOSURE.version) return "disclosure_required";
  if (await isHalted(pool)) return "halted"; // ticket 14: pairing is gateway activity too
  const pairing = await gateway.startPairing();
  // Written before the Session exists: a stray Attestation is harmless, a
  // Session whose ban-risk affirmation was never recorded is not.
  await recordAttestation(pool, userId, "ban_risk");
  const { rows } = await pool.query(
    `INSERT INTO whatsapp_sessions (user_id, external_session_id, status)
     VALUES ($1, $2, 'pending')
     RETURNING id, external_session_id, status, status_changed_at`,
    [userId, pairing.externalSessionId],
  );
  return { connection: view(rows[0]), pairing_code: pairing.pairingCode };
}

export async function listConnections(pool: pg.Pool, userId: string): Promise<ConnectionView[]> {
  const { rows } = await pool.query(
    `SELECT id, external_session_id, status, status_changed_at
     FROM whatsapp_sessions
     WHERE user_id = $1
     ORDER BY created_at`,
    [userId],
  );
  return rows.map(view);
}

// User-initiated disconnect. The user_id predicate is the tenant boundary:
// another user's connection id behaves exactly like a nonexistent one.
export async function disconnectConnection(
  pool: pg.Pool,
  userId: string,
  connectionId: string,
): Promise<"ok" | "not_found"> {
  const n = await transition(
    pool,
    `UPDATE whatsapp_sessions SET status = 'disconnected', status_changed_at = now()
     WHERE id = $1 AND user_id = $2 RETURNING id`,
    [connectionId, userId],
    "disconnected",
  );
  return n === 0 ? "not_found" : "ok";
}

// Gateway-reported state change arriving on the webhook. Unknown session: no-op.
export async function applyGatewayStatus(
  pool: pg.Pool,
  gateway: GatewayPort,
  evt: NormalizedStatus,
): Promise<void> {
  await transition(
    pool,
    `UPDATE whatsapp_sessions SET status = $2, status_changed_at = now()
     WHERE external_session_id = $1 RETURNING id`,
    [evt.sessionExternalId, evt.status],
    evt.status,
  );
  if (evt.status === "connected") {
    await startTrial(pool, gateway, evt.sessionExternalId);
    // Best-effort like the seeding below: a gateway that cannot name the Session
    // must not cost the Account its connect. The next 'connected' retries.
    await captureSelfIdentity(pool, gateway, evt.sessionExternalId).catch(() => {});
    // Best-effort: a gateway hiccup here must not undo the status flip. The next
    // 'connected' (or the group's first message) fills the list instead.
    await seedGroups(pool, gateway, evt.sessionExternalId).catch(() => {});
    // Order matters: seedGroups creates this Session's rows, adoptGroups moves
    // the Account's existing choices onto them. Best-effort for the same reason
    // as the seed — migration 024 and the next 'connected' both retry it.
    await adoptGroups(pool, evt.sessionExternalId).catch(() => {});
  }
}

// Ticket 25 (spec §96-99, §232): reaching 'connected' is what "pairing
// completes" means, so the Trial starts here rather than at POST /v1/connections
// — a pairing code that was never scanned grants nothing.
//
// A gateway hiccup replays 'connected' on every reconnect, so the Account's own
// Trial is checked before the gateway is asked for anything. An Account whose
// number was already trialed elsewhere costs one /me call per reconnect and
// still gets no Trial, which is the point of story §97.
// ponytail: that repeat lookup is fine at one call per reconnect; store the
// number hash on the Session if reconnect storms ever make it matter.
async function startTrial(
  pool: pg.Pool,
  gateway: GatewayPort,
  sessionExternalId: string,
): Promise<void> {
  const { rows } = await pool.query(
    `SELECT s.user_id FROM whatsapp_sessions s
      WHERE s.external_session_id = $1
        AND NOT EXISTS (SELECT 1 FROM trials t WHERE t.user_id = s.user_id)`,
    [sessionExternalId],
  );
  const userId = rows[0]?.user_id as string | undefined;
  if (!userId) return;
  // A gateway that cannot name the paired number must not cost the Account its
  // Trial silently — but it also must not mint one that isn't tied to a number,
  // or story §97 stops holding. No number, no grant; the next 'connected' retries.
  const numberSha256 = await gateway.sessionNumberSha256(sessionExternalId).catch(() => null);
  if (numberSha256) await grantTrial(pool, userId, numberSha256);
}

// Ticket 02 (migration 030). Who the Account holder is on WhatsApp, so later
// work can answer "was this addressed to me?" rather than guess. Read on every
// 'connected' so an identity the gateway could not name earlier fills in later.
//
// COALESCE, not a plain assignment: a gateway that answers /me with blanks on a
// reconnect must not erase an identity that was known a minute ago.
async function captureSelfIdentity(
  pool: pg.Pool,
  gateway: GatewayPort,
  sessionExternalId: string,
): Promise<void> {
  const me = await gateway.sessionIdentity(sessionExternalId);
  await pool.query(
    `UPDATE whatsapp_sessions
        SET self_phone = COALESCE($2, self_phone),
            self_lid   = COALESCE($3, self_lid),
            self_name  = COALESCE($4, self_name)
      WHERE external_session_id = $1`,
    [sessionExternalId, me.phone, me.lid, me.name],
  );
}

// The Account's identity, newest identified Session first. ADR-0001 gives an
// Account one live Session, but re-pairing leaves the retired rows behind, and
// a row that was never identified would otherwise shadow one that was.
export async function selfIdentity(pool: pg.Pool, userId: string): Promise<SelfIdentity | null> {
  const { rows } = await pool.query(
    `SELECT self_phone AS phone, self_lid AS lid, self_name AS name
       FROM whatsapp_sessions
      WHERE user_id = $1 AND (self_phone IS NOT NULL OR self_lid IS NOT NULL)
      ORDER BY created_at DESC
      LIMIT 1`,
    [userId],
  );
  return (rows[0] as SelfIdentity | undefined) ?? null;
}

// Ticket 20 (spec §13-14, §242-245, ADR-0001). One gateway process holds every
// Account's Session, so a Session with no enabled Group and nobody logging in is
// capacity spent on nothing. Retiring it to 're_pair_required' is a capacity
// control, not a punishment: the Account pairs again and is whole. The eviction
// opens a Coverage Gap like any other loss of coverage, so Summaries spanning
// the idle window say so instead of presenting themselves as complete.
//
// Idleness is measured from the last login, falling back to when the Session was
// created — an Account that paired and never came back is exactly the case this
// exists for. One statement so the flip and its gap cannot land apart.
export const IDLE_EVICTION_DAYS = 14;

export async function evictIdleSessions(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query(
    `WITH evicted AS (
       UPDATE whatsapp_sessions s
          SET status = 're_pair_required', status_changed_at = now()
        WHERE s.status <> 're_pair_required'
          AND NOT EXISTS (SELECT 1 FROM groups g WHERE g.session_id = s.id AND g.enabled)
          AND COALESCE((SELECT u.last_login_at FROM users u WHERE u.id = s.user_id),
                       s.created_at) < now() - $1::interval
        RETURNING s.id
     ), gaps AS (
       INSERT INTO coverage_gaps (session_id, reason)
       SELECT e.id, 're_pair_required' FROM evicted e
        WHERE NOT EXISTS (SELECT 1 FROM coverage_gaps cg
                           WHERE cg.session_id = e.id AND cg.ended_at IS NULL)
       RETURNING session_id
     )
     SELECT count(*)::int AS n FROM evicted`,
    [`${IDLE_EVICTION_DAYS} days`],
  );
  return rows[0].n as number;
}

// Flip the session status and keep coverage_gaps consistent in one transaction:
// leaving 'connected' opens a gap (at most one open per session), returning to
// 'connected' closes any open gap. Downstream summary windows overlapping a gap
// are flagged incomplete instead of silently truncated.
async function transition(
  pool: pg.Pool,
  updateSql: string,
  params: unknown[],
  newStatus: SessionStatus,
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const res = await client.query(updateSql, params);
    if (res.rowCount === 0) {
      await client.query("ROLLBACK");
      return 0;
    }
    const sessionId = res.rows[0].id;
    if (newStatus === "connected") {
      await client.query(
        `UPDATE coverage_gaps SET ended_at = now() WHERE session_id = $1 AND ended_at IS NULL`,
        [sessionId],
      );
    } else {
      await client.query(
        `INSERT INTO coverage_gaps (session_id, reason)
         SELECT $1, $2
         WHERE NOT EXISTS
           (SELECT 1 FROM coverage_gaps WHERE session_id = $1 AND ended_at IS NULL)`,
        [sessionId, newStatus],
      );
    }
    await client.query("COMMIT");
    return res.rowCount ?? 0;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
