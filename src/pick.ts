import { createHash } from "node:crypto";
import type pg from "pg";
import type { Config } from "./config.ts";
import type { BriefSource, TodayBrief } from "./brief.ts";
import { selfIdentity } from "./connections.ts";
import { mentionsSelf } from "./sender-names.ts";
import { decrypt } from "./crypto.ts";
import { accountKey } from "./accounts.ts";

// PickerPort — the third AI boundary, same shape as SummarizerPort and
// AnswererPort: plain data in, plain data out, no tool access. It answers one
// question over a day's already-extracted items: which of these actually need
// this person today?
//
// The safety property is not the prompt. The model can only return keys, and
// validatePick drops every key it was not given — so a hallucinated item cannot
// reach the user, because there is no free-text channel for one to arrive in.

export type PickBucket = "needs_action" | "decided" | "worth_noting";

export type PickCandidate = {
  // Stable identity of the item: summary_id|section|item_index of its first
  // source — the same string the app already uses to address item state, so a
  // picked item and a cleared item are one identifier and either filters the other.
  key: string;
  text: string;
  group_name: string | null;
  bucket: PickBucket;
  // Deterministic, computed before the call — the model is told this, never
  // asked to infer it.
  tagged: boolean;
};

export type PickerInput = { candidates: PickCandidate[]; self_name: string | null };

export type PickerResult = {
  output: unknown; // candidate pick JSON — validated, never trusted
  model: string;
  promptVersion: string;
};

export interface PickerPort {
  pick(input: PickerInput): Promise<PickerResult>;
}

export type Pick = { headline: string; keys: string[] };

// A hard ceiling in code, not a request in the prompt. Whatever the model
// returns, the calm view can never grow back into a list.
export const MAX_PICK = 5;

const MAX_HEADLINE = 200;
const EMPTY: Pick = { headline: "", keys: [] };

// Force untrusted picker output into the locked shape: keys that were never
// candidates are dropped, duplicates collapse, the rest is truncated to
// MAX_PICK. An empty result is a legitimate answer — "nothing needs you today"
// is the outcome this whole feature exists to make possible.
export function validatePick(raw: unknown, validKeys: ReadonlySet<string>): Pick {
  if (typeof raw !== "object" || raw === null) return EMPTY;
  const r = raw as Record<string, unknown>;
  const headline = typeof r.headline === "string" ? r.headline.trim().slice(0, MAX_HEADLINE) : "";
  const keys = (Array.isArray(r.keys) ? r.keys : []).filter(
    (k): k is string => typeof k === "string" && validKeys.has(k),
  );
  return { headline, keys: [...new Set(keys)].slice(0, MAX_PICK) };
}

export function candidateKey(s: BriefSource): string {
  return `${s.summary_id}|${s.section}|${s.item_index}`;
}

// Candidates are today's items minus anything the user already cleared, each
// carrying a deterministic `tagged` flag. Tagging reads the item's own source
// messages through the per-Account key (ADR-0002) while they are still inside
// the raw window; past expiry it falls back to the item text, where the mention
// has already been rewritten to "@Name".
// ponytail: one decrypt pass over the day's messages per re-pick. The cache
// makes that once a day, not once a page load — fold it into the summarize step
// if an Account with many groups ever makes it show.
export async function buildCandidates(
  pool: pg.Pool,
  config: Config,
  userId: string,
  brief: TodayBrief,
): Promise<{ candidates: PickCandidate[]; selfName: string | null }> {
  // A row exists only while the item is complete or dismissed — clearing the
  // state deletes it — so presence means "the user already dealt with this".
  const states = await pool.query(
    `SELECT summary_id, section, item_index FROM item_states WHERE user_id = $1`,
    [userId],
  );
  const cleared = new Set(
    states.rows.map((r) => `${r.summary_id}|${r.section}|${r.item_index}`),
  );

  const self = await selfIdentity(pool, userId);
  const taggedMessageIds = new Set<string>();
  if (self) {
    const key = await accountKey(pool, config, userId);
    const msgs = await pool.query(
      `SELECT id, body_ciphertext FROM messages
       WHERE user_id = $1 AND sent_at > now() - interval '24 hours' AND NOT from_me`,
      [userId],
    );
    for (const m of msgs.rows) {
      if (mentionsSelf(decrypt(m.body_ciphertext as Buffer, key), self)) {
        taggedMessageIds.add(m.id as string);
      }
    }
  }

  const buckets: [PickBucket, TodayBrief["needs_action"]][] = [
    ["needs_action", brief.needs_action],
    ["decided", brief.decided],
    ["worth_noting", brief.worth_noting],
  ];
  const candidates: PickCandidate[] = [];
  for (const [bucket, items] of buckets) {
    for (const item of items) {
      const first = item.sources[0];
      if (!first) continue;
      const key = candidateKey(first);
      if (cleared.has(key)) continue;
      candidates.push({
        key,
        text: item.text,
        group_name: first.group_name,
        bucket,
        tagged:
          item.sources.some((s) => s.source_message_ids.some((id) => taggedMessageIds.has(id))) ||
          mentionsSelf(item.text, self),
      });
    }
  }
  return { candidates, selfName: self?.name ?? null };
}

// Fingerprint of exactly what the picker would be shown. Same inputs, same
// pick, no call.
function fingerprint(candidates: PickCandidate[]): string {
  const h = createHash("sha256");
  for (const c of candidates) h.update(JSON.stringify([c.key, c.text, c.tagged]));
  return h.digest("hex");
}

// The day's pick, cached per (Account, local day). A day with nothing in it
// never reaches the model: "nothing happened" needs no judgement. A model
// outage degrades to an empty pick, not to a 500 — and is not cached, so the
// next load retries.
export async function pickForToday(
  pool: pg.Pool,
  picker: PickerPort,
  config: Config,
  userId: string,
  brief: TodayBrief,
): Promise<Pick> {
  const { candidates, selfName } = await buildCandidates(pool, config, userId, brief);
  if (candidates.length === 0) return EMPTY;

  const hash = fingerprint(candidates);
  const cached = await pool.query(
    `SELECT headline, item_keys FROM briefs
     WHERE user_id = $1 AND day = $2::date AND input_hash = $3`,
    [userId, brief.date, hash],
  );
  if (cached.rows.length > 0) {
    return { headline: cached.rows[0].headline as string, keys: cached.rows[0].item_keys as string[] };
  }

  let result: PickerResult;
  try {
    result = await picker.pick({ candidates, self_name: selfName });
  } catch (err) {
    console.error("picker error", err);
    return EMPTY;
  }
  const pick = validatePick(result.output, new Set(candidates.map((c) => c.key)));

  // A re-pick replaces the day's row, and clears delivered_at only when the
  // picked keys actually changed into something worth a message — otherwise a
  // refresh after ticket 06's message has gone out would cause a second one,
  // and a day whose items were all cleared would re-announce its own silence.
  //
  // due_at is set on the insert only (ticket 7): a pick with something in it is
  // due the moment it exists, an empty one waits for the digest clock to say
  // "nothing needs you today" at the hour the Account chose. On a row that
  // already exists, whoever wrote it owns its timing — a pushing Group pulls it
  // forward itself, and the clock arms it when the hour comes.
  await pool.query(
    `INSERT INTO briefs (user_id, day, input_hash, headline, item_keys, due_at)
     VALUES ($1, $2::date, $3, $4, $5,
             CASE WHEN $5::text[] = '{}' THEN 'infinity' ELSE now() END)
     ON CONFLICT (user_id, day) DO UPDATE SET
       input_hash   = EXCLUDED.input_hash,
       headline     = EXCLUDED.headline,
       item_keys    = EXCLUDED.item_keys,
       created_at   = now(),
       delivered_at = CASE WHEN EXCLUDED.item_keys = '{}'
                             OR briefs.item_keys = EXCLUDED.item_keys
                           THEN briefs.delivered_at ELSE NULL END`,
    [userId, brief.date, hash, pick.headline, pick.keys],
  );
  return pick;
}
