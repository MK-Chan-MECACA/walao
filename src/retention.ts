import type pg from "pg";

// One global raw-retention window per user (spec: 1-30 days, default 7).
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 30;

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
// a controlled clock. Returns rows deleted.
export async function purgeExpired(pool: pg.Pool, now: Date = new Date()): Promise<number> {
  const res = await pool.query(`DELETE FROM messages WHERE expires_at <= $1`, [now]);
  return res.rowCount ?? 0;
}
