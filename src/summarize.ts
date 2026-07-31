import type pg from "pg";
import type { Config } from "./config.ts";
import { decrypt } from "./crypto.ts";
import type { Language } from "./scheduler.ts";

// SummarizerPort — the AI boundary (spec: batch + config in, structured JSON
// out). The port receives plain data and returns plain data; it holds no tool
// access, so hostile message text has nothing to trigger. Whatever it returns
// is treated as untrusted and forced through validateSummary before storage.

export type BatchMessage = {
  id: string;
  sender_ref: string | null;
  sent_at: string; // ISO
  text: string;
};

export type SummarizerInput = {
  language: Language;
  messages: BatchMessage[];
};

export type SummarizerResult = {
  output: unknown; // candidate summary JSON — validated, never trusted
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
};

export interface SummarizerPort {
  summarize(input: SummarizerInput): Promise<SummarizerResult>;
}

// The locked output contract (README §11).
export type Cited = { text: string; source_message_ids: string[] };
export type ActionItem = Cited & {
  owner: string | null;
  due_at: string | null;
  confidence: number;
};
export type SummaryPayload = {
  highlights: Cited[];
  decisions: Cited[];
  action_items: ActionItem[];
  dates: Cited[];
  open_questions: Cited[];
  memory_candidates: Cited[];
};

// "Nothing happened": all sections explicitly empty — never invented content.
export function emptySummary(): SummaryPayload {
  return {
    highlights: [],
    decisions: [],
    action_items: [],
    dates: [],
    open_questions: [],
    memory_candidates: [],
  };
}

const CITED_SECTIONS = [
  "highlights",
  "decisions",
  "dates",
  "open_questions",
  "memory_candidates",
] as const;

// Force untrusted summarizer output into the locked schema. Unknown keys are
// discarded (output structure cannot be altered from inside the model), items
// are rebuilt field by field, and any claim without at least one source id
// from the actual batch is dropped — the citation contract.
export function validateSummary(raw: unknown, validIds: ReadonlySet<string>): SummaryPayload {
  const out = emptySummary();
  if (typeof raw !== "object" || raw === null) return out;
  const r = raw as Record<string, unknown>;
  for (const key of CITED_SECTIONS) {
    out[key] = asArray(r[key]).flatMap((it) => {
      const c = cited(it, validIds);
      return c ? [c] : [];
    });
  }
  out.action_items = asArray(r.action_items).flatMap((it) => {
    const c = cited(it, validIds);
    if (!c) return [];
    const o = it as Record<string, unknown>;
    return [
      {
        ...c,
        owner: typeof o.owner === "string" ? o.owner : null,
        due_at: typeof o.due_at === "string" ? o.due_at : null,
        confidence:
          typeof o.confidence === "number" && Number.isFinite(o.confidence)
            ? Math.min(1, Math.max(0, o.confidence))
            : 0,
      },
    ];
  });
  return out;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function cited(it: unknown, validIds: ReadonlySet<string>): Cited | null {
  if (typeof it !== "object" || it === null) return null;
  const o = it as Record<string, unknown>;
  if (typeof o.text !== "string" || o.text.trim() === "") return null;
  const ids = asArray(o.source_message_ids).filter(
    (x): x is string => typeof x === "string" && validIds.has(x),
  );
  if (ids.length === 0) return null;
  return { text: o.text, source_message_ids: [...new Set(ids)] };
}

// Process pending summary jobs: load the window's batch, deterministic cleaning
// (decrypt, exclude from_me system echoes, drop blank texts), then the
// summarizer, then validation, then one summaries row with metrics. One job per
// transaction so a bad job can't wedge the rest; a summarizer failure marks the
// job failed and moves on. Routine logs never contain message bodies.
// ponytail: AI call runs inside the claiming transaction, holding a connection
// for the call's duration; split claim/complete if real-model latency matters.
export async function processSummaryJobs(
  pool: pg.Pool,
  summarizer: SummarizerPort,
  config: Config,
): Promise<number> {
  let processed = 0;
  for (;;) {
    const client = await pool.connect();
    let jobId: string | null = null;
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `SELECT j.id, j.group_id, j.language, j.window_start, j.window_end, s.user_id
         FROM summary_jobs j
         JOIN groups g ON g.id = j.group_id
         JOIN whatsapp_sessions s ON s.id = g.session_id
         JOIN users u ON u.id = s.user_id
         WHERE j.status = 'pending' AND NOT u.paused
         ORDER BY j.id
         FOR UPDATE OF j SKIP LOCKED
         LIMIT 1`,
      );
      if (rows.length === 0) {
        await client.query("COMMIT");
        break;
      }
      const job = rows[0];
      jobId = job.id;

      const msgs = await client.query(
        `SELECT id, sender_ref, sent_at, body_ciphertext FROM messages
         WHERE group_id = $1 AND sent_at > $2 AND sent_at <= $3 AND NOT from_me
         ORDER BY sent_at`,
        [job.group_id, job.window_start, job.window_end],
      );
      const batch: BatchMessage[] = msgs.rows
        .map((m) => ({
          id: m.id as string,
          sender_ref: m.sender_ref as string | null,
          sent_at: (m.sent_at as Date).toISOString(),
          text: decrypt(m.body_ciphertext, config.encKey).trim(),
        }))
        .filter((m) => m.text.length > 0);

      let payload = emptySummary();
      let model = "none";
      let promptVersion = "none";
      let inputTokens = 0;
      let outputTokens = 0;
      let durationMs = 0;
      if (batch.length > 0) {
        const t0 = Date.now();
        const res = await summarizer.summarize({ language: job.language, messages: batch });
        durationMs = Date.now() - t0;
        payload = validateSummary(res.output, new Set(batch.map((m) => m.id)));
        model = res.model;
        promptVersion = res.promptVersion;
        inputTokens = res.inputTokens;
        outputTokens = res.outputTokens;
      }

      await client.query(
        `INSERT INTO summaries
           (user_id, group_id, job_id, language, window_start, window_end,
            payload, model, prompt_version, input_tokens, output_tokens, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          job.user_id,
          job.group_id,
          job.id,
          job.language,
          job.window_start,
          job.window_end,
          JSON.stringify(payload),
          model,
          promptVersion,
          inputTokens,
          outputTokens,
          durationMs,
        ],
      );
      await client.query(`UPDATE summary_jobs SET status = 'done' WHERE id = $1`, [job.id]);
      await client.query("COMMIT");
      processed++;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      if (jobId === null) throw err; // infrastructure failure before a job was claimed
      // Job-level failure: park it and keep draining. Log ids only — no bodies.
      await pool
        .query(`UPDATE summary_jobs SET status = 'failed' WHERE id = $1`, [jobId])
        .catch(() => {});
      console.error(`summary job ${jobId} failed:`, err instanceof Error ? err.message : "error");
    } finally {
      client.release();
    }
  }
  return processed;
}
