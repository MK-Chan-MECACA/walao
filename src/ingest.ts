import type pg from "pg";
import type { GatewayPort } from "./gateway/port.ts";
import type { Config } from "./config.ts";
import { verifyHmac } from "./crypto.ts";

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

  const ageSeconds = Math.abs((Date.now() - evt.sentAt.getTime()) / 1000);
  if (!Number.isFinite(ageSeconds) || ageSeconds > config.freshnessSeconds) return { status: 400 };

  await pool.query(
    `INSERT INTO ingest_events (session_external_id, external_id, payload)
     VALUES ($1, $2, $3)
     ON CONFLICT (session_external_id, external_id) DO NOTHING`,
    [evt.sessionExternalId, evt.externalMessageId, JSON.stringify(json)],
  );

  return { status: 202 };
}
