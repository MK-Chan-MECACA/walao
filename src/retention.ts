import type pg from "pg";

// One global raw-retention window per user (spec: 1-30 days, default 7).
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 30;

// Summaries are the read side of the product, not raw chat — but not permanent
// either. 008 and 010 already promise a confirmed Reminder/Memory "outlives its
// ~90-day source summary"; this is that promise implemented. Those rows copy
// their text at confirmation time and reference the summary ON DELETE SET NULL,
// so a purge never takes a user-confirmed fact with it. item_states CASCADE —
// there is nothing left to hold a state about.
export const SUMMARY_RETENTION_DAYS = 90;

export async function getRetentionDays(pool: pg.Pool, userId: string): Promise<number> {
  const { rows } = await pool.query(`SELECT retention_days FROM users WHERE id = $1`, [userId]);
  return rows[0].retention_days;
}

// Out-of-range values clamp to [1, 30] per spec; non-numeric input is rejected.
// The new window applies to subsequently stored messages only: expiry is
// stamped at store time, so already-stored messages keep the window they were
// stored under.
export async function setRetentionDays(
  pool: pg.Pool,
  userId: string,
  days: unknown,
): Promise<number | "invalid"> {
  if (typeof days !== "number" || !Number.isFinite(days)) return "invalid";
  const clamped = Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, Math.round(days)));
  await pool.query(`UPDATE users SET retention_days = $2 WHERE id = $1`, [userId, clamped]);
  return clamped;
}

// Delete every raw message whose expiry has passed — all senders equally,
// WALAO users or not. `now` is injectable so the whole-system test can advance
// a controlled clock. Returns rows deleted (messages only — the credential
// sweeps below ride this timer rather than owning one, and nothing counts them).
export async function purgeExpired(pool: pg.Pool, now: Date = new Date()): Promise<number> {
  const res = await pool.query(`DELETE FROM messages WHERE expires_at <= $1`, [now]);

  await pool.query(
    `DELETE FROM summaries WHERE created_at <= $1::timestamptz - make_interval(days => $2)`,
    [now, SUMMARY_RETENTION_DAYS],
  );

  // F7: an expired token already fails authenticate(); dropping the hash means
  // the row stops holding a credential at all.
  await pool.query(
    `UPDATE users SET api_token_sha256 = NULL, token_expires_at = NULL
     WHERE token_expires_at <= $1 AND api_token_sha256 IS NOT NULL`,
    [now],
  );
  // F3: expired Operator sessions are refused on lookup; this is the cleanup.
  await pool.query(`DELETE FROM operator_sessions WHERE expires_at <= $1`, [now]);
  // F4: a limiter window nobody has touched for a day cannot deny anything.
  await pool.query(`DELETE FROM rate_limits WHERE window_start < $1::timestamptz - interval '1 day'`, [
    now,
  ]);

  return res.rowCount ?? 0;
}
