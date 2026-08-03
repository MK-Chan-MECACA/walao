import type pg from "pg";
import type { SummaryPayload } from "./summarize.ts";
import type { BriefItem } from "./brief.ts";
import { jumpUrl } from "./surfaces.ts";

// Memory beta (ticket 12). Candidates are never materialized: they are read
// straight out of stored summaries' memory_candidates sections, so an
// unconfirmed candidate "expires" simply by its summary aging out of the
// window — no sweeper job. Confirmation copies the candidate into the
// memories table, the only path to permanence.

// ponytail: 7-day candidate window (matches default raw retention); make it a
// user setting if anyone asks for longer review time.
export const CANDIDATE_WINDOW_DAYS = 7;

export type MemoryCandidate = {
  summary_id: string;
  item_index: number;
  text: string;
  source_message_ids: string[];
  group_id: string;
  group_name: string | null;
  jump_url: string;
  proposed_at: string;
  expires_at: string;
};

// Unconfirmed candidates from summaries still inside the window, newest first.
// Already-confirmed ones drop out of the review list.
export async function listCandidates(pool: pg.Pool, userId: string): Promise<MemoryCandidate[]> {
  const [{ rows }, confirmed] = await Promise.all([
    pool.query(
      `SELECT s.id, s.payload, s.created_at, s.group_id, g.name, g.external_jid
       FROM summaries s
       JOIN groups g ON g.id = s.group_id
       WHERE s.user_id = $1 AND s.created_at > now() - make_interval(days => $2)
       ORDER BY s.created_at DESC`,
      [userId, CANDIDATE_WINDOW_DAYS],
    ),
    pool.query(
      `SELECT summary_id, item_index FROM memories WHERE user_id = $1 AND summary_id IS NOT NULL`,
      [userId],
    ),
  ]);
  const done = new Set(confirmed.rows.map((r) => `${r.summary_id}:${r.item_index}`));
  const out: MemoryCandidate[] = [];
  for (const r of rows) {
    const createdAt = r.created_at as Date;
    ((r.payload as SummaryPayload).memory_candidates ?? []).forEach((c, i) => {
      if (done.has(`${r.id}:${i}`)) return;
      out.push({
        summary_id: r.id as string,
        item_index: i,
        text: c.text,
        source_message_ids: c.source_message_ids,
        group_id: r.group_id as string,
        group_name: r.name as string | null,
        jump_url: jumpUrl(r.external_jid as string),
        proposed_at: createdAt.toISOString(),
        expires_at: new Date(
          createdAt.getTime() + CANDIDATE_WINDOW_DAYS * 86400_000,
        ).toISOString(),
      });
    });
  }
  return out;
}

export type Memory = {
  id: string;
  content: string;
  source: {
    summary_id: string | null;
    group_jid: string | null;
    jump_url: string | null;
    source_message_ids: string[];
  };
  created_at: string;
  confirmed_by: string;
  last_used_at: string | null;
};

// Explicit confirmation — the only path that creates a memory. Tenant check
// first (404 over 400, same rule as surfaces.ts); an expired candidate cannot
// be confirmed. Confirming twice is idempotent.
export async function confirmCandidate(
  pool: pg.Pool,
  userId: string,
  summaryId: string,
  itemIndex: number,
): Promise<"not_found" | "invalid" | "expired" | Memory> {
  const { rows } = await pool.query(
    `SELECT s.payload, s.created_at, g.external_jid
     FROM summaries s JOIN groups g ON g.id = s.group_id
     WHERE s.id = $1 AND s.user_id = $2`,
    [summaryId, userId],
  );
  if (rows.length === 0) return "not_found";
  const cand = (rows[0].payload as SummaryPayload).memory_candidates[itemIndex];
  if (!cand) return "invalid";
  if (Date.now() - (rows[0].created_at as Date).getTime() > CANDIDATE_WINDOW_DAYS * 86400_000) {
    return "expired";
  }
  const ins = await pool.query(
    `INSERT INTO memories
       (user_id, summary_id, item_index, content, source_message_ids, group_jid, confirmed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $1)
     ON CONFLICT (user_id, summary_id, item_index) DO NOTHING
     RETURNING id`,
    [userId, summaryId, itemIndex, cand.text, cand.source_message_ids, rows[0].external_jid],
  );
  const id =
    ins.rows[0]?.id ??
    (
      await pool.query(
        `SELECT id FROM memories WHERE user_id = $1 AND summary_id = $2 AND item_index = $3`,
        [userId, summaryId, itemIndex],
      )
    ).rows[0].id;
  const list = await listMemories(pool, userId);
  return list.find((m) => m.id === id) as Memory;
}

export async function listMemories(pool: pg.Pool, userId: string): Promise<Memory[]> {
  const { rows } = await pool.query(
    `SELECT id, content, summary_id, group_jid, source_message_ids, created_at,
            confirmed_by, last_used_at
     FROM memories WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id as string,
    content: r.content as string,
    source: {
      summary_id: r.summary_id as string | null,
      group_jid: r.group_jid as string | null,
      jump_url: r.group_jid ? jumpUrl(r.group_jid as string) : null,
      source_message_ids: r.source_message_ids as string[],
    },
    created_at: (r.created_at as Date).toISOString(),
    confirmed_by: r.confirmed_by as string,
    last_used_at: r.last_used_at ? (r.last_used_at as Date).toISOString() : null,
  }));
}

// Edit a memory's content — the source trail and audit fields stay immutable.
export async function updateMemory(
  pool: pg.Pool,
  userId: string,
  memoryId: string,
  body: unknown,
): Promise<"not_found" | "invalid" | Memory> {
  const content = (typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {})
    .content;
  const { rows } = await pool.query(`SELECT id FROM memories WHERE id = $1 AND user_id = $2`, [
    memoryId,
    userId,
  ]);
  if (rows.length === 0) return "not_found";
  if (typeof content !== "string" || content.trim() === "") return "invalid";
  await pool.query(`UPDATE memories SET content = $1 WHERE id = $2`, [content, memoryId]);
  const list = await listMemories(pool, userId);
  return list.find((m) => m.id === memoryId) as Memory;
}

export async function deleteMemory(
  pool: pg.Pool,
  userId: string,
  memoryId: string,
): Promise<"ok" | "not_found"> {
  const { rowCount } = await pool.query(`DELETE FROM memories WHERE id = $1 AND user_id = $2`, [
    memoryId,
    userId,
  ]);
  return rowCount ? "ok" : "not_found";
}

export type RecurringRisk = BriefItem & { occurrences: number };

export type OverdueItem = {
  reminder_id: string;
  text: string;
  owner: string | null;
  due_at: string;
};

export type WeeklyReview = {
  week_end: string; // YYYY-MM-DD
  summary_count: number;
  decisions: BriefItem[];
  overdue: OverdueItem[];
  recurring_risks: RecurringRisk[];
};

// Weekly review digest, built on demand from stored summaries and confirmed
// reminders — same summaries-only rule as the Today Brief, so raw expiry never
// affects it. Recurring risks = the same open question surfacing in two or
// more summaries across the week, which a single day's brief can't see.
// ponytail: exact normalized-text match for recurrence; add fuzzy matching if
// real summaries phrase the same risk differently.
export async function buildWeeklyReview(pool: pg.Pool, userId: string): Promise<WeeklyReview> {
  const [summaries, overdue] = await Promise.all([
    pool.query(
      `SELECT s.id, s.group_id, s.payload, g.name AS group_name, g.external_jid
       FROM summaries s
       JOIN groups g ON g.id = s.group_id
       WHERE s.user_id = $1 AND s.window_end > now() - interval '7 days'
       ORDER BY s.created_at`,
      [userId],
    ),
    pool.query(
      `SELECT id, text, owner, due_at FROM reminders
       WHERE user_id = $1 AND status = 'open' AND due_at < now()
       ORDER BY due_at`,
      [userId],
    ),
  ]);

  const decisions = new Map<string, RecurringRisk>();
  const risks = new Map<string, RecurringRisk>();
  for (const r of summaries.rows) {
    const payload = r.payload as SummaryPayload;
    for (const [section, merged] of [
      ["decisions", decisions],
      ["open_questions", risks],
    ] as const) {
      for (const [index, it] of (payload[section] ?? []).entries()) {
        const key = it.text.trim().toLowerCase();
        let item = merged.get(key);
        if (!item) {
          item = { text: it.text, sources: [], occurrences: 0 };
          merged.set(key, item);
        }
        item.occurrences += 1;
        item.sources.push({
          summary_id: r.id as string,
          group_id: r.group_id as string,
          group_name: r.group_name as string | null,
          jump_url: jumpUrl(r.external_jid as string),
          section,
          item_index: index,
          source_message_ids: it.source_message_ids,
        });
      }
    }
  }

  return {
    week_end: new Date().toISOString().slice(0, 10),
    summary_count: summaries.rows.length,
    decisions: [...decisions.values()].map(({ text, sources }) => ({ text, sources })),
    overdue: overdue.rows.map((r) => ({
      reminder_id: r.id as string,
      text: r.text as string,
      owner: r.owner as string | null,
      due_at: (r.due_at as Date).toISOString(),
    })),
    recurring_risks: [...risks.values()].filter((r) => r.occurrences >= 2),
  };
}
