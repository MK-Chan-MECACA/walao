import type pg from "pg";

// Plan limits (README §14-15): visible caps on groups, message volume, and AI
// usage so costs stay bounded per plan. Credits are legible usage units:
// 1 credit = 1 AI-generated group summary (spec §51) — derived by counting
// summaries rows with a real model, never a separate ledger.
// Values are the Free/Pro research hypotheses from README §15; plan changes
// (payments) are out of scope — operators flip users.plan directly.
export const PLANS = {
  free: { max_groups: 3, max_messages_per_day: 500, max_summaries_per_day: 5 },
  pro: { max_groups: 20, max_messages_per_day: 5000, max_summaries_per_day: 50 },
} as const;

export type PlanName = keyof typeof PLANS;

type Db = pg.Pool | pg.PoolClient;

// Trial (spec §96-99, §229-234): 14 days of Pro's caps starting when pairing
// completes, no card. Expiry degrades the service to Free rather than ending it,
// so there is nothing to clean up when it lapses — the row just stops counting.
export const TRIAL_DAYS = 14;

// The one place plan resolution lives: an active Trial IS Pro for as long as it
// runs. Every cap reads through here (or through the same CASE in block.ts), so
// a Trial account cannot be Pro at one gate and Free at the next.
export async function getPlan(db: Db, userId: string): Promise<PlanName> {
  const { rows } = await db.query(
    `SELECT CASE WHEN EXISTS (SELECT 1 FROM trials t
                               WHERE t.user_id = u.id AND t.ends_at > now())
                 THEN 'pro' ELSE u.plan END AS plan
     FROM users u WHERE u.id = $1`,
    [userId],
  );
  return (rows[0]?.plan ?? "free") as PlanName;
}

// Once per WhatsApp number, not once per Account (spec §97) — the unique index
// on the hash is what enforces that, so a re-signup with the same number is a
// no-op here rather than a second Trial.
export async function grantTrial(db: Db, userId: string, numberSha256: string): Promise<void> {
  await db.query(
    `INSERT INTO trials (user_id, number_sha256, ends_at)
     VALUES ($1, $2, now() + $3::interval)
     ON CONFLICT (number_sha256) DO NOTHING`,
    [userId, numberSha256, `${TRIAL_DAYS} days`],
  );
}

// Cancellation (spec §100-103, §239): returning to Free, never a deletion event.
// Summaries, Memories and Reminders are untouched and enabled Groups stay
// enabled — the ones past Free's cap carry an over_group_cap Processing Block
// (block.ts) until the Account disables enough or upgrades again, so upgrading
// restores exactly what it had. An active Trial still outranks this: the Trial
// is granted per number, not bought, so cancelling a subscription does not end it.
export async function cancelPlan(db: Db, userId: string): Promise<void> {
  await db.query(`UPDATE users SET plan = 'free' WHERE id = $1`, [userId]);
}

// "Today" is the UTC day throughout.
// ponytail: user-local billing day needs a per-user timezone setting; UTC until someone asks.
export async function countMessagesToday(db: Db, userId: string): Promise<number> {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM messages
     WHERE user_id = $1 AND created_at >= date_trunc('day', now())`,
    [userId],
  );
  return rows[0].n;
}

export async function creditsToday(db: Db, userId: string): Promise<number> {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM summaries
     WHERE user_id = $1 AND model <> 'none' AND created_at >= date_trunc('day', now())`,
    [userId],
  );
  return rows[0].n;
}

export type Usage = {
  plan: PlanName;
  limits: (typeof PLANS)[PlanName];
  usage: { enabled_groups: number; messages_today: number; credits_today: number };
  groups: { group_id: string; name: string | null; credits_30d: number }[];
  // Null once it lapses (spec §98-99): the caps above are already Free's again,
  // and a finished Trial is not a state the user has to act on.
  trial: { ends_at: string; days_remaining: number } | null;
};

// The visibility half of spec §51-53: plan, limits, current burn, and per-group
// credit burn (last 30 days) so the user can spot and mute expensive groups.
export async function getUsage(pool: pg.Pool, userId: string): Promise<Usage> {
  const plan = await getPlan(pool, userId);
  const [groups, messages, credits, burn, trial] = await Promise.all([
    pool.query(
      `SELECT count(*)::int AS n FROM groups g
       JOIN whatsapp_sessions s ON s.id = g.session_id
       WHERE s.user_id = $1 AND g.enabled`,
      [userId],
    ),
    countMessagesToday(pool, userId),
    creditsToday(pool, userId),
    pool.query(
      `SELECT s.group_id, g.name, count(*)::int AS credits_30d
       FROM summaries s JOIN groups g ON g.id = s.group_id
       WHERE s.user_id = $1 AND s.model <> 'none'
         AND s.created_at >= now() - interval '30 days'
       GROUP BY s.group_id, g.name
       ORDER BY credits_30d DESC, g.name`,
      [userId],
    ),
    // Days rounded up, so the last partial day still reads as "1 day left"
    // rather than "0" while the Trial is genuinely still running.
    pool.query(
      `SELECT ends_at, ceil(extract(epoch FROM ends_at - now()) / 86400)::int AS days_remaining
       FROM trials WHERE user_id = $1 AND ends_at > now()`,
      [userId],
    ),
  ]);
  return {
    plan,
    limits: PLANS[plan],
    usage: {
      enabled_groups: groups.rows[0].n,
      messages_today: messages,
      credits_today: credits,
    },
    groups: burn.rows,
    trial: trial.rows[0]
      ? {
          ends_at: new Date(trial.rows[0].ends_at as string).toISOString(),
          days_remaining: trial.rows[0].days_remaining as number,
        }
      : null,
  };
}
