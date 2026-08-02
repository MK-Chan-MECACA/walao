import type pg from "pg";
import { PLANS, type PlanName } from "./billing.ts";

// Processing Block (spec §27-31, §212-218). One module owns the question "is
// WALAO processing for this account right now?" so no stage keeps a private
// guard and the API can always answer with a reason instead of a boolean.

export type BlockReason =
  | "halted"
  | "unpaid"
  | "paused"
  | "unpaired"
  | "disconnected"
  | "over_group_cap"
  | "over_daily_messages"
  | "over_daily_credits";

export type Block = { reason: BlockReason };

export type Stage = "ingest" | "schedule" | "summarize" | "deliver" | "outbound";

// The account-state reasons stop every stage. A cap stops only the stage that
// spends the capped resource: blocking delivery on the credit cap would withhold
// the very summaries those credits paid for, blocking it on the message cap
// would punish a full inbox by hiding the summary of it, and blocking the
// scheduler on the credit cap would delete the capped job the user is meant to
// see. Asking without a stage — the "is WALAO processing right now?" question —
// sees every reason.
const CAP_STAGES: Record<"over_group_cap" | "over_daily_messages" | "over_daily_credits", Stage[]> =
  {
    over_group_cap: ["ingest", "schedule", "summarize"],
    over_daily_messages: ["ingest"],
    over_daily_credits: ["summarize"],
  };

type Db = pg.Pool | pg.PoolClient;

// Precedence runs outermost cause first: a halted product outranks a billing
// problem, which outranks the account's own pause, which outranks connection
// state, which outranks the plan caps. The first true reason is the one the
// user is shown, so it is always the one they'd have to fix first.
//
// Session state is per Account, not per session row: an Account with no
// connected session is disconnected (or unpaired if it never reached
// 'connected'), which is what ADR-0001's one-session-per-Account model means.
//
// ponytail: one round trip per stage per item. Batch it if a drain loop ever
// shows up in load — the shape is already a single row per account.
export async function processingBlock(
  db: Db,
  userId: string,
  opts: { groupId?: string; stage?: Stage } = {},
): Promise<Block | null> {
  const { groupId, stage } = opts;
  const { rows } = await db.query(
    `SELECT (SELECT halted FROM system_halt) AS halted,
            u.paused, u.unpaid, u.plan,
            EXISTS (SELECT 1 FROM whatsapp_sessions
                     WHERE user_id = u.id AND status = 'connected') AS connected,
            EXISTS (SELECT 1 FROM whatsapp_sessions
                     WHERE user_id = u.id AND status = 'disconnected') AS was_connected,
            (SELECT count(*)::int FROM messages
              WHERE user_id = u.id AND created_at >= date_trunc('day', now())) AS messages_today,
            (SELECT count(*)::int FROM summaries
              WHERE user_id = u.id AND model <> 'none'
                AND created_at >= date_trunc('day', now())) AS credits_today,
            (SELECT count(*)::int FROM groups g
               JOIN whatsapp_sessions s ON s.id = g.session_id
              WHERE s.user_id = u.id AND g.enabled
                AND g.enabled_at < (SELECT enabled_at FROM groups WHERE id = $2)) AS enabled_before
     FROM users u WHERE u.id = $1`,
    [userId, groupId ?? null],
  );
  const r = rows[0];
  if (!r) return { reason: "unpaired" }; // no such account: nothing to process

  if (r.halted) return { reason: "halted" };
  if (r.unpaid) return { reason: "unpaid" };
  if (r.paused) return { reason: "paused" };
  if (!r.connected) return { reason: r.was_connected ? "disconnected" : "unpaired" };

  // Caps are per UTC day, same clock as /v1/usage.
  const limits = PLANS[(r.plan ?? "free") as PlanName];
  const caps: (keyof typeof CAP_STAGES)[] = [];
  if (groupId && r.enabled_before >= limits.max_groups) caps.push("over_group_cap");
  if (r.messages_today >= limits.max_messages_per_day) caps.push("over_daily_messages");
  if (r.credits_today >= limits.max_summaries_per_day) caps.push("over_daily_credits");
  for (const reason of caps) {
    if (!stage || CAP_STAGES[reason].includes(stage)) return { reason };
  }
  return null;
}

// Coverage gaps for blocks that mean lost coverage (spec §31, §217). Halt,
// disconnect and pause open theirs at the moment of the flip; the daily message
// cap can only be known when an over-cap event arrives, so ingestion opens that
// one here. At most one open gap per session, so whichever reason opened first
// owns the window.
// The gap reason stays 'plan_limit' for the message cap — it is the stored
// history's name for it, and renaming it would rewrite past gaps for nothing.
export async function openGap(db: Db, sessionId: string, reason: string): Promise<void> {
  await db.query(
    `INSERT INTO coverage_gaps (session_id, reason)
     SELECT $1, $2 WHERE NOT EXISTS
       (SELECT 1 FROM coverage_gaps WHERE session_id = $1 AND ended_at IS NULL)`,
    [sessionId, reason],
  );
}

export async function closeGap(db: Db, sessionId: string, reason: string): Promise<void> {
  await db.query(
    `UPDATE coverage_gaps SET ended_at = now()
     WHERE session_id = $1 AND reason = $2 AND ended_at IS NULL`,
    [sessionId, reason],
  );
}

export type Status = {
  processing: boolean;
  block: Block | null;
  session: { status: string; status_changed_at: string } | null;
  coverage_gap: { reason: string; started_at: string } | null;
};

// The single "is WALAO working" answer the app renders (spec §216).
export async function getStatus(pool: pg.Pool, userId: string): Promise<Status> {
  const [block, sess, gap] = await Promise.all([
    processingBlock(pool, userId),
    pool.query(
      // Newest first: after an eviction (ticket 20) the retired Session row stays
      // for its history, and the one the Account just paired is the one it asked
      // about. With the one-Session-per-Account rule this is the same row anyway.
      `SELECT status, status_changed_at FROM whatsapp_sessions
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId],
    ),
    pool.query(
      // Same Session the status line reports: an evicted Session's gap stays
      // open as the record of the window it lost, but "is WALAO covering me now"
      // is a question about the Session the Account currently holds.
      `SELECT cg.reason, cg.started_at FROM coverage_gaps cg
       WHERE cg.session_id = (SELECT id FROM whatsapp_sessions
                               WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1)
         AND cg.ended_at IS NULL
       ORDER BY cg.started_at LIMIT 1`,
      [userId],
    ),
  ]);
  return {
    processing: block === null,
    block,
    session: sess.rows[0]
      ? {
          status: sess.rows[0].status as string,
          status_changed_at: new Date(sess.rows[0].status_changed_at as string).toISOString(),
        }
      : null,
    coverage_gap: gap.rows[0]
      ? {
          reason: gap.rows[0].reason as string,
          started_at: new Date(gap.rows[0].started_at as string).toISOString(),
        }
      : null,
  };
}
