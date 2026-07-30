import type pg from "pg";
import type { GatewayPort } from "./gateway/port.ts";
import type { ActionItem, SummaryPayload } from "./summarize.ts";

const SECTIONS: [keyof SummaryPayload, string][] = [
  ["highlights", "Highlights"],
  ["decisions", "Decisions"],
  ["action_items", "Action items"],
  ["dates", "Dates"],
  ["open_questions", "Open questions"],
  ["memory_candidates", "Memory candidates"],
];

// Plain-text rendering for the user's own chat; citations stay in the stored
// payload where the app can show them.
// ponytail: English section labels regardless of summary language; localize
// the label map when a non-EN beta user asks.
export function renderSummary(
  groupName: string | null,
  windowEnd: Date,
  payload: SummaryPayload,
  incomplete: boolean,
): string {
  const lines = [`WALAO brief — ${groupName ?? "group"} (${windowEnd.toISOString().slice(0, 10)})`];
  if (incomplete) {
    lines.push(
      "⚠️ Incomplete: WALAO was disconnected during part of this window, so some messages may be missing.",
    );
  }
  let items = 0;
  for (const [key, label] of SECTIONS) {
    const arr = payload[key];
    if (arr.length === 0) continue;
    lines.push("", `${label}:`);
    for (const it of arr) {
      const extra = key === "action_items" ? actionSuffix(it as ActionItem) : "";
      lines.push(`• ${it.text}${extra}`);
      items++;
    }
  }
  if (items === 0) lines.push("", "Nothing happened in this window.");
  return lines.join("\n");
}

function actionSuffix(a: ActionItem): string {
  const parts = [a.owner, a.due_at && `due ${a.due_at}`].filter(Boolean);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

// Deliver stored summaries to the user's own chat through the gateway port.
// One summary per transaction, claimed with SKIP LOCKED like the other drains.
// Only connected sessions are attempted — a disconnected session's summaries
// simply wait for reconnection. A summary whose window overlaps a coverage gap
// is rendered with a visible incomplete warning instead of silently truncated.
// A send failure rolls back and the row retries on the next tick (at-least-once:
// a crash between send and commit can duplicate a chat message, never lose one).
export async function deliverSummaries(pool: pg.Pool, gateway: GatewayPort): Promise<number> {
  let delivered = 0;
  for (;;) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `SELECT s.id, s.payload, s.window_end, g.name AS group_name,
                ws.external_session_id,
                EXISTS (SELECT 1 FROM coverage_gaps cg
                        WHERE cg.session_id = ws.id
                          AND cg.started_at < s.window_end
                          AND (cg.ended_at IS NULL OR cg.ended_at > s.window_start)) AS incomplete
         FROM summaries s
         JOIN groups g ON g.id = s.group_id
         JOIN whatsapp_sessions ws ON ws.id = g.session_id
         WHERE s.delivered_at IS NULL AND ws.status = 'connected'
         ORDER BY s.created_at
         FOR UPDATE OF s SKIP LOCKED
         LIMIT 1`,
      );
      if (rows.length === 0) {
        await client.query("COMMIT");
        break;
      }
      const r = rows[0];
      const text = renderSummary(
        r.group_name as string | null,
        r.window_end as Date,
        r.payload as SummaryPayload,
        r.incomplete as boolean,
      );
      await gateway.sendToSelf(r.external_session_id as string, text);
      await client.query(`UPDATE summaries SET delivered_at = now() WHERE id = $1`, [r.id]);
      await client.query("COMMIT");
      delivered++;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      // Ids only in routine logs — never message content.
      console.error("summary delivery failed:", err instanceof Error ? err.message : "error");
      break; // gateway likely down; leave the rest for the next tick
    } finally {
      client.release();
    }
  }
  return delivered;
}
