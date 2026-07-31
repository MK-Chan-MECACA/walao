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

export async function getPlan(db: Db, userId: string): Promise<PlanName> {
  const { rows } = await db.query(`SELECT plan FROM users WHERE id = $1`, [userId]);
  return (rows[0]?.plan ?? "free") as PlanName;
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
};

// The visibility half of spec §51-53: plan, limits, current burn, and per-group
// credit burn (last 30 days) so the user can spot and mute expensive groups.
export async function getUsage(pool: pg.Pool, userId: string): Promise<Usage> {
  const plan = await getPlan(pool, userId);
  const [groups, messages, credits, burn] = await Promise.all([
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
  };
}
