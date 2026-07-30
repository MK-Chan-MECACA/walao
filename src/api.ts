import type pg from "pg";
import type { Config } from "./config.ts";
import { decrypt, hashToken } from "./crypto.ts";

export type ApiMessage = {
  id: string;
  group_id: string;
  external_id: string;
  sender_ref: string | null;
  sent_at: string;
  text: string;
};

// Resolve a bearer token to a user id, or null. Tokens are compared by hash.
export async function authenticate(pool: pg.Pool, bearer: string | null): Promise<string | null> {
  if (!bearer) return null;
  const { rows } = await pool.query(`SELECT id FROM users WHERE api_token_sha256 = $1`, [
    hashToken(bearer),
  ]);
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
    `SELECT id, group_id, external_id, sender_ref, sent_at, body_ciphertext
     FROM messages
     WHERE user_id = $1
     ORDER BY sent_at`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    group_id: r.group_id,
    external_id: r.external_id,
    sender_ref: r.sender_ref,
    sent_at: new Date(r.sent_at).toISOString(),
    text: decrypt(r.body_ciphertext, config.encKey),
  }));
}
