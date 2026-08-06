import type pg from "pg";
import type { ActionItem, SummaryPayload } from "./summarize.ts";
import { loadSenderNames, resolvePayloadNames } from "./sender-names.ts";

// App surfaces (ticket 9): browsable summary history, per-item complete/dismiss
// state, jump-back links, and user-confirmed reminders. A reminder exists only
// because the user explicitly confirmed it — group text alone never creates one.

const SECTIONS = new Set<string>([
  "highlights",
  "decisions",
  "action_items",
  "dates",
  "open_questions",
  "memory_candidates",
]);

// ponytail: whatsapp:// jid deep link, understood by mobile clients; swap for a
// gateway-provided chat URL if a client without the scheme shows up.
export function jumpUrl(externalJid: string): string {
  return `whatsapp://chat?jid=${encodeURIComponent(externalJid)}`;
}

export type ItemState = { section: string; item_index: number; state: string };

export type SummaryHistoryEntry = {
  id: string;
  group_id: string;
  group_name: string | null;
  chat_jid: string;
  jump_url: string;
  language: string;
  window_start: string;
  window_end: string;
  created_at: string;
  payload: SummaryPayload;
  states: ItemState[];
};

// History is served from stored summaries within the ~90-day summary retention
// window; raw-message expiry never affects it.
export async function listSummaries(pool: pg.Pool, userId: string): Promise<SummaryHistoryEntry[]> {
  const { rows } = await pool.query(
    `SELECT s.id, s.group_id, g.name AS group_name, g.external_jid, s.language,
            s.window_start, s.window_end, s.created_at, s.payload,
            COALESCE((SELECT json_agg(json_build_object(
                        'section', st.section, 'item_index', st.item_index, 'state', st.state))
                      FROM item_states st
                      WHERE st.user_id = s.user_id AND st.summary_id = s.id), '[]'::json) AS states
     FROM summaries s
     JOIN groups g ON g.id = s.group_id
     WHERE s.user_id = $1 AND s.created_at > now() - interval '90 days'
     ORDER BY s.created_at DESC`,
    [userId],
  );
  // A summary written before mention resolution existed has raw "@40102864666870"
  // in its item text, and history is read for 90 days — so the names go on at
  // read time here too, not only on the Brief.
  const names = await loadSenderNames(pool, userId);
  return rows.map((r) => ({
    id: r.id as string,
    group_id: r.group_id as string,
    group_name: r.group_name as string | null,
    chat_jid: r.external_jid as string,
    jump_url: jumpUrl(r.external_jid as string),
    language: r.language as string,
    window_start: (r.window_start as Date).toISOString(),
    window_end: (r.window_end as Date).toISOString(),
    created_at: (r.created_at as Date).toISOString(),
    payload: resolvePayloadNames(names, r.payload as SummaryPayload),
    states: r.states as ItemState[],
  }));
}

// Mark an item complete/dismissed, or clear with null. Tenant check runs before
// input validation so a foreign summary id is indistinguishable from a missing
// one (404, never 400).
export async function setItemState(
  pool: pg.Pool,
  userId: string,
  summaryId: string,
  section: string,
  itemIndex: number,
  state: unknown,
): Promise<"not_found" | "invalid" | "ok"> {
  const { rows } = await pool.query(`SELECT payload FROM summaries WHERE id = $1 AND user_id = $2`, [
    summaryId,
    userId,
  ]);
  if (rows.length === 0) return "not_found";
  if (state !== null && state !== "complete" && state !== "dismissed") return "invalid";
  const payload = rows[0].payload as SummaryPayload;
  if (!SECTIONS.has(section) || itemIndex >= payload[section as keyof SummaryPayload].length)
    return "invalid";
  if (state === null) {
    await pool.query(
      `DELETE FROM item_states
       WHERE user_id = $1 AND summary_id = $2 AND section = $3 AND item_index = $4`,
      [userId, summaryId, section, itemIndex],
    );
  } else {
    await pool.query(
      `INSERT INTO item_states (user_id, summary_id, section, item_index, state)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, summary_id, section, item_index)
       DO UPDATE SET state = $5, updated_at = now()`,
      [userId, summaryId, section, itemIndex, state],
    );
  }
  return "ok";
}

export type Reminder = {
  id: string;
  summary_id: string | null;
  text: string;
  owner: string | null;
  due_at: string | null;
  status: string;
  confirmed_at: string;
  jump_url: string | null;
};

// Explicit confirmation of an extracted action item — the only path that
// creates a reminder. Text/owner/due default from the stored item; the body may
// override owner and due_at. Confirming twice is idempotent.
export async function confirmActionItem(
  pool: pg.Pool,
  userId: string,
  summaryId: string,
  itemIndex: number,
  body: unknown,
): Promise<"not_found" | "invalid" | Reminder> {
  const { rows } = await pool.query(`SELECT payload FROM summaries WHERE id = $1 AND user_id = $2`, [
    summaryId,
    userId,
  ]);
  if (rows.length === 0) return "not_found";
  const item = (rows[0].payload as SummaryPayload).action_items[itemIndex] as
    | ActionItem
    | undefined;
  if (!item) return "invalid";
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const owner = parseOwner(b.owner, item.owner);
  const dueAt = parseDueAt(b.due_at, item.due_at);
  if (owner === undefined || dueAt === undefined) return "invalid";

  const ins = await pool.query(
    `INSERT INTO reminders (user_id, summary_id, item_index, text, owner, due_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, summary_id, item_index) DO NOTHING
     RETURNING id`,
    [userId, summaryId, itemIndex, item.text, owner, dueAt],
  );
  const id =
    ins.rows[0]?.id ??
    (
      await pool.query(
        `SELECT id FROM reminders WHERE user_id = $1 AND summary_id = $2 AND item_index = $3`,
        [userId, summaryId, itemIndex],
      )
    ).rows[0].id;
  const list = await listReminders(pool, userId);
  return list.find((r) => r.id === id) as Reminder;
}

export async function listReminders(pool: pg.Pool, userId: string): Promise<Reminder[]> {
  const { rows } = await pool.query(
    `SELECT r.id, r.summary_id, r.text, r.owner, r.due_at, r.status, r.confirmed_at,
            g.external_jid
     FROM reminders r
     LEFT JOIN summaries s ON s.id = r.summary_id
     LEFT JOIN groups g ON g.id = s.group_id
     WHERE r.user_id = $1
     ORDER BY r.confirmed_at`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id as string,
    summary_id: r.summary_id as string | null,
    text: r.text as string,
    owner: r.owner as string | null,
    due_at: r.due_at ? (r.due_at as Date).toISOString() : null,
    status: r.status as string,
    confirmed_at: (r.confirmed_at as Date).toISOString(),
    jump_url: r.external_jid ? jumpUrl(r.external_jid as string) : null,
  }));
}

// Edit a confirmed reminder's owner, due date, or status. Absent fields keep
// their value; tenant check first, same 404-over-400 rule as setItemState.
export async function updateReminder(
  pool: pg.Pool,
  userId: string,
  reminderId: string,
  body: unknown,
): Promise<"not_found" | "invalid" | Reminder> {
  const { rows } = await pool.query(
    `SELECT owner, due_at, status FROM reminders WHERE id = $1 AND user_id = $2`,
    [reminderId, userId],
  );
  if (rows.length === 0) return "not_found";
  const cur = rows[0];
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const owner = parseOwner(b.owner, cur.owner as string | null);
  const dueAt = parseDueAt(b.due_at, cur.due_at ? (cur.due_at as Date).toISOString() : null);
  const status =
    b.status === undefined
      ? (cur.status as string)
      : b.status === "open" || b.status === "done" || b.status === "dismissed"
        ? b.status
        : undefined;
  if (owner === undefined || dueAt === undefined || status === undefined) return "invalid";
  await pool.query(`UPDATE reminders SET owner = $1, due_at = $2, status = $3 WHERE id = $4`, [
    owner,
    dueAt,
    status,
    reminderId,
  ]);
  const list = await listReminders(pool, userId);
  return list.find((r) => r.id === reminderId) as Reminder;
}

// undefined = invalid input; absent field falls back to the current value.
function parseOwner(v: unknown, fallback: string | null): string | null | undefined {
  if (v === undefined) return fallback;
  if (v === null || typeof v === "string") return v;
  return undefined;
}

function parseDueAt(v: unknown, fallback: string | null): string | null | undefined {
  if (v === undefined) return fallback;
  if (v === null) return null;
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return v;
  return undefined;
}
