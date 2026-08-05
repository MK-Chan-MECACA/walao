import type pg from "pg";

// F4: abuse control for the three routes anyone can call.
//
// Signup and login each send a real email, so an unthrottled endpoint is a mail
// bomb aimed at any address the attacker likes and a bill aimed at us. Verify is
// an 8-character code, which is strong enough that guessing is not the worry —
// the worry is the volume of guessing.
//
// Fixed windows, one row per bucket, counted in Postgres: it survives a restart,
// it holds across replicas, and it is one statement. ponytail: a fixed window
// lets a burst straddle two windows and land 2N requests; swap for a sliding
// window only if that turns out to matter, which for "5 emails an hour" it does
// not.

export type Limit = { limit: number; windowMs: number };

// Per address and per source, separately: the address limit stops one mailbox
// being flooded, the source limit stops one attacker flooding many mailboxes.
export const EMAIL_CODE_PER_EMAIL: Limit = { limit: 5, windowMs: 3600_000 };
export const EMAIL_CODE_PER_IP: Limit = { limit: 20, windowMs: 3600_000 };
export const VERIFY_PER_EMAIL: Limit = { limit: 10, windowMs: 900_000 };
export const VERIFY_PER_IP: Limit = { limit: 20, windowMs: 900_000 };

// True if this request is inside the limit — and counts it. One statement, so
// two concurrent requests cannot both read "4 so far" and both proceed: the
// upsert takes the row lock and the second one sees the first one's count.
export async function allow(
  pool: pg.Pool,
  bucket: string,
  { limit, windowMs }: Limit,
): Promise<boolean> {
  const window = `${windowMs} milliseconds`;
  const { rows } = await pool.query(
    `INSERT INTO rate_limits (bucket, count, window_start) VALUES ($1, 1, now())
     ON CONFLICT (bucket) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start <= now() - $2::interval
                    THEN 1 ELSE rate_limits.count + 1 END,
       window_start = CASE WHEN rate_limits.window_start <= now() - $2::interval
                           THEN now() ELSE rate_limits.window_start END
     RETURNING count`,
    [bucket, window],
  );
  return rows[0].count <= limit;
}

// Both buckets are counted even when the first one already said no — a request
// that was refused for its address still came from somewhere, and not counting
// it would let an attacker spend one address's quota to protect its own.
export async function allowBoth(
  pool: pg.Pool,
  kind: string,
  email: string,
  ip: string,
  perEmail: Limit,
  perIp: Limit,
): Promise<boolean> {
  const [emailOk, ipOk] = await Promise.all([
    allow(pool, `${kind}:email:${email}`, perEmail),
    allow(pool, `${kind}:ip:${ip}`, perIp),
  ]);
  return emailOk && ipOk;
}
