import type pg from "pg";
import type { GatewayPort } from "./gateway/port.ts";
import type { Config } from "./config.ts";
import { verifyHmac } from "./crypto.ts";
import { applyGatewayStatus } from "./connections.ts";

export type IngestResult =
  | { status: 202 } // accepted (or idempotent replay — both are 202, no trace difference)
  | { status: 400 } // unparseable / stale
  | { status: 401 }; // bad signature

// Webhook ingress. Rejects forged (bad HMAC) and stale events BEFORE any write,
// so they leave no trace. Valid events are enqueued into the durable Postgres
// queue and returned fast; duplicates are a no-op via the unique key.
export async function ingestWebhook(
  pool: pg.Pool,
  gateway: GatewayPort,
  config: Config,
  rawBody: Buffer,
  signatureHeader: string,
): Promise<IngestResult> {
  if (!verifyHmac(rawBody, signatureHeader, config.webhookSecret)) return { status: 401 };

  let json: unknown;
  try {
    json = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return { status: 400 };
  }

  let evt;
  try {
    evt = gateway.parse(json);
  } catch {
    return { status: 400 };
  }

  // Session status changes (ticket 3) are state updates, not data — applied
  // directly, no queue. Unknown sessions are ignored inside.
  if (evt.type === "status") {
    await applyGatewayStatus(pool, evt);
    return { status: 202 };
  }

  const ageSeconds = Math.abs((Date.now() - evt.sentAt.getTime()) / 1000);
  if (!Number.isFinite(ageSeconds) || ageSeconds > config.freshnessSeconds) return { status: 400 };

  // Consent boundary (ticket 2): only events for groups the user explicitly
  // enabled may enter the durable queue. Everything else is dropped HERE — the
  // payload is never persisted anywhere. All drops still answer 202 so the
  // response doesn't leak which groups a user subscribes to.
  const sub = await pool.query(
    `SELECT s.id AS session_id, s.status AS session_status, g.id AS group_id, g.enabled
     FROM whatsapp_sessions s
     LEFT JOIN groups g ON g.session_id = s.id AND g.external_jid = $2
     WHERE s.external_session_id = $1`,
    [evt.sessionExternalId, evt.groupJid],
  );
  if (sub.rows.length === 0) return { status: 202 }; // unknown session: unattributable, drop
  const { session_id: sessionId, session_status: sessionStatus, group_id: groupId, enabled } =
    sub.rows[0];
  // Disconnect boundary (ticket 3): a non-connected session ingests nothing —
  // not even group discovery. Silent 202 like the consent drops.
  if (sessionStatus !== "connected") return { status: 202 };
  if (!groupId) {
    // First sighting: register the group (metadata only, disabled by default)
    // so it shows up in the user's list to enable. The message itself is dropped.
    await pool.query(
      `INSERT INTO groups (session_id, external_jid, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (session_id, external_jid) DO NOTHING`,
      [sessionId, evt.groupJid, evt.groupName],
    );
    return { status: 202 };
  }
  if (!enabled) return { status: 202 };

  await pool.query(
    `INSERT INTO ingest_events (session_external_id, external_id, payload)
     VALUES ($1, $2, $3)
     ON CONFLICT (session_external_id, external_id) DO NOTHING`,
    [evt.sessionExternalId, evt.externalMessageId, JSON.stringify(json)],
  );

  return { status: 202 };
}
