import type pg from "pg";
import { PLANS, type PlanName } from "./billing.ts";
import { getStatus, type Status } from "./block.ts";

// Operator console (spec §105, §109, §249). Everything here is metadata:
// counts, job status, connection history and token usage. No message or
// Summary body is reachable through these — the review queue (quality.ts,
// gated on quality_review_opt_in) stays the one exception in the product.
// Group names are left out for the same reason: they are member-authored text,
// not an operational fact an Operator needs to support the Account.

export type AccountMetadata = {
  account: {
    id: string;
    email: string | null;
    plan: PlanName;
    paused: boolean;
    unpaid: boolean;
    quality_review_opt_in: boolean;
    retention_days: number;
    created_at: string;
    last_login_at: string | null;
  };
  status: Status;
  counts: {
    sessions: number;
    groups: number;
    groups_enabled: number;
    messages: number;
    summaries: number;
    reminders: number;
    memories: number;
  };
  jobs: Record<string, number>;
  sessions: {
    external_session_id: string;
    status: string;
    status_changed_at: string;
    created_at: string;
  }[];
  tokens: { input: number; output: number };
};

export async function accountMetadata(
  pool: pg.Pool,
  userId: string,
): Promise<AccountMetadata | null> {
  const [acct, jobs, sessions, status] = await Promise.all([
    pool.query(
      // u.plan is the stored Plan, not the Trial-resolved one — an Operator
      // changing a Plan needs to see the row they are about to write. The
      // effective Plan is visible through status.block anyway.
      `SELECT u.id, u.email, u.plan, u.paused, u.unpaid, u.quality_review_opt_in,
              u.retention_days, u.created_at, u.last_login_at,
              (SELECT count(*)::int FROM whatsapp_sessions WHERE user_id = u.id) AS n_sessions,
              (SELECT count(*)::int FROM groups g JOIN whatsapp_sessions s ON s.id = g.session_id
                WHERE s.user_id = u.id) AS n_groups,
              (SELECT count(*)::int FROM groups g JOIN whatsapp_sessions s ON s.id = g.session_id
                WHERE s.user_id = u.id AND g.enabled) AS n_groups_enabled,
              (SELECT count(*)::int FROM messages WHERE user_id = u.id) AS n_messages,
              (SELECT count(*)::int FROM summaries WHERE user_id = u.id) AS n_summaries,
              (SELECT count(*)::int FROM reminders WHERE user_id = u.id) AS n_reminders,
              (SELECT count(*)::int FROM memories WHERE user_id = u.id) AS n_memories,
              (SELECT coalesce(sum(input_tokens), 0)::int FROM summaries
                WHERE user_id = u.id) AS input_tokens,
              (SELECT coalesce(sum(output_tokens), 0)::int FROM summaries
                WHERE user_id = u.id) AS output_tokens
       FROM users u WHERE u.id = $1`,
      [userId],
    ),
    pool.query(
      `SELECT j.status, count(*)::int AS n FROM summary_jobs j
       JOIN groups g ON g.id = j.group_id
       JOIN whatsapp_sessions s ON s.id = g.session_id
       WHERE s.user_id = $1 GROUP BY j.status`,
      [userId],
    ),
    pool.query(
      `SELECT external_session_id, status, status_changed_at, created_at
       FROM whatsapp_sessions WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    ),
    getStatus(pool, userId),
  ]);
  const r = acct.rows[0];
  if (!r) return null;
  return {
    account: {
      id: r.id,
      email: r.email,
      plan: r.plan,
      paused: r.paused,
      unpaid: r.unpaid,
      quality_review_opt_in: r.quality_review_opt_in,
      retention_days: r.retention_days,
      created_at: new Date(r.created_at).toISOString(),
      last_login_at: r.last_login_at ? new Date(r.last_login_at).toISOString() : null,
    },
    status,
    counts: {
      sessions: r.n_sessions,
      groups: r.n_groups,
      groups_enabled: r.n_groups_enabled,
      messages: r.n_messages,
      summaries: r.n_summaries,
      reminders: r.n_reminders,
      memories: r.n_memories,
    },
    jobs: Object.fromEntries(jobs.rows.map((j) => [j.status as string, j.n as number])),
    sessions: sessions.rows.map((s) => ({
      external_session_id: s.external_session_id as string,
      status: s.status as string,
      status_changed_at: new Date(s.status_changed_at as string).toISOString(),
      created_at: new Date(s.created_at as string).toISOString(),
    })),
    tokens: { input: r.input_tokens, output: r.output_tokens },
  };
}

// Plan changes are an Operator action until a payment provider exists (§109,
// §313). Nothing else moves: an upgrade lifts the caps on the next request and
// a downgrade leaves Groups enabled but over-cap, exactly like Cancellation.
export async function setPlan(
  pool: pg.Pool,
  userId: string,
  plan: unknown,
): Promise<PlanName | "invalid" | "not_found"> {
  if (typeof plan !== "string" || !(plan in PLANS)) return "invalid";
  const { rowCount } = await pool.query(`UPDATE users SET plan = $2 WHERE id = $1`, [userId, plan]);
  return rowCount ? (plan as PlanName) : "not_found";
}
