import type pg from "pg";

// Ticket 16 (spec §54-55): weekly quality operations, operator-only surface.
// §54 names an interim quality owner for the Malay lane; transfers to a
// Malay-primary beta user once recruited — change this constant then.
export const MALAY_QUALITY_OWNER = "product-owner";

// Ticket 27 (§107): the Account grants or revokes the one exception to the
// operator boundary. Revoking pulls its Summaries out of the queue immediately;
// reviews already recorded stay, they are the quality trail (§112).
export async function setQualityReviewOptIn(
  pool: pg.Pool,
  userId: string,
  optIn: unknown,
): Promise<"invalid" | boolean> {
  if (typeof optIn !== "boolean") return "invalid";
  await pool.query(`UPDATE users SET quality_review_opt_in = $2 WHERE id = $1`, [userId, optIn]);
  return optIn;
}

export async function getQualityReviewOptIn(pool: pg.Pool, userId: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT quality_review_opt_in FROM users WHERE id = $1`, [
    userId,
  ]);
  return rows[0]?.quality_review_opt_in ?? false;
}

// Everything reviewable in the last 7 days. Malay summaries are listed
// individually until each has a review (§54); the beta lane is one weekly
// record of accuracy/omission/privacy-event counts (§55).
export async function reviewQueue(pool: pg.Pool): Promise<unknown> {
  const [malay, { rows }] = await Promise.all([
    pool.query(
      `SELECT s.id AS summary_id, s.user_id, s.group_id, s.window_start, s.window_end,
              s.payload, s.created_at
       FROM summaries s JOIN users u ON u.id = s.user_id
       WHERE s.language = 'ms'
         AND u.quality_review_opt_in
         AND s.created_at > now() - interval '7 days'
         AND NOT EXISTS (SELECT 1 FROM quality_reviews q WHERE q.summary_id = s.id)
       ORDER BY s.created_at`,
    ),
    pool.query(
    `SELECT
       (SELECT count(*)::int FROM summaries
        WHERE created_at > now() - interval '7 days') AS summaries_7d,
       (SELECT count(*)::int FROM privacy_audit
        WHERE created_at > now() - interval '7 days') AS privacy_events_7d,
       (SELECT EXISTS (SELECT 1 FROM quality_reviews
        WHERE kind = 'beta' AND created_at > now() - interval '7 days')) AS reviewed`,
    ),
  ]);
  return {
    malay: { quality_owner: MALAY_QUALITY_OWNER, pending: malay.rows },
    beta: rows[0],
  };
}

export async function recordReview(
  pool: pg.Pool,
  body: unknown,
): Promise<"invalid" | "not_found" | { id: string }> {
  const b = (body ?? {}) as Record<string, unknown>;
  const { kind, reviewer, verdict } = b;
  if (typeof reviewer !== "string" || reviewer.trim() === "") return "invalid";
  if (typeof verdict !== "object" || verdict === null || Array.isArray(verdict)) return "invalid";
  const v = verdict as Record<string, unknown>;

  if (kind === "malay") {
    // A Malay review must state pass/fail and point at a real ms summary.
    // The uuid shape guard keeps a typo'd id a 400, not a Postgres cast 500.
    if (typeof b.summary_id !== "string" || typeof v.ok !== "boolean") return "invalid";
    if (!/^[0-9a-f-]{36}$/.test(b.summary_id)) return "invalid";
    // One review per summary (015's unique index); a resubmit corrects it.
    const { rows } = await pool.query(
      `INSERT INTO quality_reviews (kind, summary_id, reviewer, verdict)
       SELECT 'malay', s.id, $2, $3 FROM summaries s JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 AND s.language = 'ms' AND u.quality_review_opt_in
       ON CONFLICT (summary_id) WHERE kind = 'malay'
       DO UPDATE SET reviewer = EXCLUDED.reviewer, verdict = EXCLUDED.verdict
       RETURNING id`,
      [b.summary_id, reviewer, JSON.stringify(verdict)],
    );
    return rows.length === 0 ? "not_found" : { id: rows[0].id };
  }

  if (kind === "beta") {
    // §55: the weekly review must state its counts explicitly — a record with
    // the numbers missing is not a review.
    for (const key of ["accuracy_issues", "omissions", "privacy_events"]) {
      const n = v[key];
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return "invalid";
    }
    const { rows } = await pool.query(
      `INSERT INTO quality_reviews (kind, reviewer, verdict) VALUES ('beta', $1, $2) RETURNING id`,
      [reviewer, JSON.stringify(verdict)],
    );
    return { id: rows[0].id };
  }

  return "invalid";
}
