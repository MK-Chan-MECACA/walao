import type pg from "pg";
import type { SummaryPayload } from "./summarize.ts";

export type BriefSource = {
  summary_id: string;
  group_id: string;
  group_name: string | null;
  source_message_ids: string[];
};

export type BriefItem = { text: string; sources: BriefSource[] };

export type TodayBrief = {
  date: string; // YYYY-MM-DD
  summary_count: number;
  needs_action: BriefItem[];
  decided: BriefItem[];
  worth_noting: BriefItem[];
};

type Bucket = "needs_action" | "decided" | "worth_noting";

// Section → bucket ranking. Action items and open questions demand something
// from the user; decisions are settled; everything else is reference.
const BUCKETS: [keyof SummaryPayload, Bucket][] = [
  ["action_items", "needs_action"],
  ["open_questions", "needs_action"],
  ["decisions", "decided"],
  ["highlights", "worth_noting"],
  ["dates", "worth_noting"],
  ["memory_candidates", "worth_noting"],
];

// Build the Today Brief from stored summaries only — never raw messages, so it
// works unchanged after raw expiry. The same item text appearing in several
// groups merges into one entry that keeps every source reference. A day with
// no summaries yields an explicit empty brief.
// ponytail: "today" = window_end in the last 24h; switch to the user's local
// calendar day when a timezone complaint arrives.
export async function buildTodayBrief(pool: pg.Pool, userId: string): Promise<TodayBrief> {
  const { rows } = await pool.query(
    `SELECT s.id, s.group_id, s.payload, g.name AS group_name
     FROM summaries s
     JOIN groups g ON g.id = s.group_id
     WHERE s.user_id = $1 AND s.window_end > now() - interval '24 hours'
     ORDER BY s.created_at`,
    [userId],
  );
  const brief: TodayBrief = {
    date: new Date().toISOString().slice(0, 10),
    summary_count: rows.length,
    needs_action: [],
    decided: [],
    worth_noting: [],
  };
  const merged = new Map<string, BriefItem>();
  for (const r of rows) {
    const payload = r.payload as SummaryPayload;
    for (const [section, bucket] of BUCKETS) {
      for (const it of payload[section] ?? []) {
        const key = `${bucket}\n${it.text.trim().toLowerCase()}`;
        let item = merged.get(key);
        if (!item) {
          item = { text: it.text, sources: [] };
          merged.set(key, item);
          brief[bucket].push(item);
        }
        item.sources.push({
          summary_id: r.id as string,
          group_id: r.group_id as string,
          group_name: r.group_name as string | null,
          source_message_ids: it.source_message_ids,
        });
      }
    }
  }
  return brief;
}
