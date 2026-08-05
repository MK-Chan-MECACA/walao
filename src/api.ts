import type pg from "pg";
import type { Config } from "./config.ts";
import { decrypt, hashToken } from "./crypto.ts";
import { accountKey } from "./accounts.ts";
import type { Cited, SummaryPayload } from "./summarize.ts";

export type ApiMessage = {
  id: string;
  group_id: string;
  external_id: string;
  sender_ref: string | null;
  sender_name: string | null;
  sent_at: string;
  text: string;
};

// Resolve a bearer token to a user id, or null. Tokens are compared by hash.
// F7: an expired token is no token — the check is in the same query as the
// lookup so there is no path that reads one without the other.
export async function authenticate(pool: pg.Pool, bearer: string | null): Promise<string | null> {
  if (!bearer) return null;
  const { rows } = await pool.query(
    `SELECT id FROM users WHERE api_token_sha256 = $1 AND token_expires_at > now()`,
    [hashToken(bearer)],
  );
  return rows.length ? rows[0].id : null;
}

// Tenant-scoped read. The WHERE user_id = $1 is the hard isolation boundary:
// there is no code path that returns another user's rows.
export async function listMessages(
  pool: pg.Pool,
  config: Config,
  userId: string,
): Promise<ApiMessage[]> {
  const { rows } = await pool.query(
    `SELECT id, group_id, external_id, sender_ref, sender_name, sent_at, body_ciphertext
     FROM messages
     WHERE user_id = $1
     ORDER BY sent_at`,
    [userId],
  );
  const key = await accountKey(pool, config, userId);
  return rows.map((r) => ({
    id: r.id,
    group_id: r.group_id,
    external_id: r.external_id,
    sender_ref: r.sender_ref,
    sender_name: r.sender_name,
    sent_at: new Date(r.sent_at).toISOString(),
    text: decrypt(r.body_ciphertext, key),
  }));
}

export type SourceMessage = Omit<ApiMessage, "external_id">;

// Ticket 29 (app spec, "Citations"): the evidence behind one Summary — only the
// messages that Summary's own items cite, never the Account's wider history.
// Two boundaries hold it: WHERE user_id = $1 on both reads, so a Summary the
// Account does not own is indistinguishable from one that does not exist
// (null => 404), and the id list comes from that Summary's payload alone.
export async function summarySources(
  pool: pg.Pool,
  config: Config,
  userId: string,
  summaryId: string,
): Promise<SourceMessage[] | null> {
  const { rows } = await pool.query(
    `SELECT payload FROM summaries WHERE id = $1 AND user_id = $2`,
    [summaryId, userId],
  );
  if (!rows.length) return null;
  const ids = citedIds(rows[0].payload as SummaryPayload);
  if (ids.length === 0) return [];

  const msgs = await pool.query(
    `SELECT id, group_id, sender_ref, sender_name, sent_at, body_ciphertext
     FROM messages
     WHERE user_id = $1 AND id = ANY($2::uuid[])
     ORDER BY sent_at`,
    [userId, ids],
  );
  const key = await accountKey(pool, config, userId);
  return msgs.rows.map((r) => ({
    id: r.id,
    group_id: r.group_id,
    sender_ref: r.sender_ref,
    sender_name: r.sender_name,
    sent_at: new Date(r.sent_at).toISOString(),
    text: decrypt(r.body_ciphertext, key),
  }));
}

// Every source id cited anywhere in a payload, deduped. The uuid filter is not
// paranoia about validateSummary — it is what keeps a malformed stored payload
// from turning a read into a 22P02 at the ::uuid[] cast.
function citedIds(payload: SummaryPayload): string[] {
  const ids = Object.values(payload)
    .filter(Array.isArray)
    .flat()
    .flatMap((it) => (it as Cited).source_message_ids ?? [])
    .filter((id) => typeof id === "string" && /^[0-9a-f-]{36}$/.test(id));
  return [...new Set(ids)];
}
