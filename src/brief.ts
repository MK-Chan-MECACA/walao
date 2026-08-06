import type pg from "pg";
import type { SummaryPayload } from "./summarize.ts";
import { jumpUrl } from "./surfaces.ts";
import { loadSenderNames, resolvePayloadNames } from "./sender-names.ts";

// section/item_index locate the item inside its Summary, so the Brief can act
// on what it shows: the state and confirm routes are keyed on exactly this pair
// and the app would otherwise have to guess it back by matching text.
export type BriefSource = {
  summary_id: string;
  group_id: string;
  group_name: string | null;
  jump_url: string;
  section: keyof SummaryPayload;
  item_index: number;
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
    `SELECT s.id, s.group_id, s.payload, g.name AS group_name, g.external_jid
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
  const names = await loadSenderNames(pool, userId);
  for (const r of rows) {
    // Resolved before the merge key is taken, so two groups that named the same
    // person still collapse into one entry.
    const payload = resolvePayloadNames(names, r.payload as SummaryPayload);
    for (const [section, bucket] of BUCKETS) {
      for (const [index, it] of (payload[section] ?? []).entries()) {
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
          jump_url: jumpUrl(r.external_jid as string),
          section,
          item_index: index,
          source_message_ids: it.source_message_ids,
        });
      }
    }
  }
  return brief;
}
