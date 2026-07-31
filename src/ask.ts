import type pg from "pg";
import type { Config } from "./config.ts";
import { decrypt } from "./crypto.ts";
import type { SummaryPayload } from "./summarize.ts";

// AnswererPort — the Ask WALAO AI boundary, same shape as SummarizerPort:
// plain data in (question + retrieved sources), plain data out. The port holds
// no tool access, so hostile text inside retrieved messages has nothing to
// trigger; whatever comes back is forced through validateAnswer before the
// user sees it.

export type AskSource = {
  id: string;
  // 'message' sources are inside the raw-retention window (verbatim allowed);
  // 'summary' sources are paraphrase-only material.
  kind: "message" | "summary";
  text: string;
};

export type AnswererInput = { question: string; sources: AskSource[] };

export type AnswererResult = {
  output: unknown; // candidate answer JSON — validated, never trusted
  model: string;
  promptVersion: string;
};

export interface AnswererPort {
  answer(input: AnswererInput): Promise<AnswererResult>;
}

// The answer contract: the answer IS a list of claims, each citing >=1 source
// actually retrieved for this question. No free-text channel exists, so an
// uncited claim is structurally impossible in a response.
export type AnswerClaim = { text: string; source_ids: string[] };
export type AskAnswer =
  | { answered: true; claims: AnswerClaim[] }
  | { answered: false; answer: "I don't know"; claims: [] };

const DONT_KNOW: AskAnswer = { answered: false, answer: "I don't know", claims: [] };

// Force untrusted answerer output into the locked shape: unknown keys are
// discarded, claims are rebuilt field by field, and any claim not citing at
// least one retrieved-source id is dropped. Nothing supported => "I don't know"
// — low confidence is never dressed up as fact.
export function validateAnswer(raw: unknown, validIds: ReadonlySet<string>): AskAnswer {
  if (typeof raw !== "object" || raw === null) return DONT_KNOW;
  const r = raw as Record<string, unknown>;
  const claims: AnswerClaim[] = (Array.isArray(r.claims) ? r.claims : []).flatMap((it) => {
    if (typeof it !== "object" || it === null) return [];
    const o = it as Record<string, unknown>;
    if (typeof o.text !== "string" || o.text.trim() === "") return [];
    const ids = (Array.isArray(o.source_ids) ? o.source_ids : []).filter(
      (x): x is string => typeof x === "string" && validIds.has(x),
    );
    if (ids.length === 0) return [];
    return [{ text: o.text, source_ids: [...new Set(ids)] }];
  });
  return claims.length > 0 ? { answered: true, claims } : DONT_KNOW;
}

// Retrieval, authz-filtered at SQL level: only the asking user's rows, only
// enabled (approved) groups. Raw messages qualify only while inside their
// retention window (expires_at > now) — beyond it the sole material is
// summaries, so past-window content can never be quoted verbatim: the raw text
// simply never reaches the model. Ranking is PostgreSQL full-text search over
// the decrypted candidates (bodies are encrypted at rest, so the tsvector is
// computed over an unnest of app-decrypted text, not a stored column).
// ponytail: full candidate scan (bounded by the <=30-day raw window + ~90-day
// summaries); add a stored tsvector or pgvector when a measured retrieval gap shows.
async function retrieveSources(
  pool: pg.Pool,
  config: Config,
  userId: string,
  question: string,
  now: Date,
): Promise<AskSource[]> {
  const msgs = await pool.query(
    `SELECT m.id, m.body_ciphertext FROM messages m
     JOIN groups g ON g.id = m.group_id
     WHERE m.user_id = $1 AND g.enabled AND NOT m.from_me AND m.expires_at > $2`,
    [userId, now],
  );
  const sums = await pool.query(
    `SELECT s.id, s.payload FROM summaries s
     JOIN groups g ON g.id = s.group_id
     WHERE s.user_id = $1 AND g.enabled`,
    [userId],
  );

  const candidates: AskSource[] = [
    ...msgs.rows.map((m) => ({
      id: m.id as string,
      kind: "message" as const,
      text: decrypt(m.body_ciphertext, config.encKey),
    })),
    ...sums.rows.map((s) => ({
      id: s.id as string,
      kind: "summary" as const,
      text: summaryText(s.payload as SummaryPayload),
    })),
  ].filter((c) => c.text.trim().length > 0);
  if (candidates.length === 0) return [];

  // OR the question's words (plainto_tsquery ANDs them — a natural-language
  // question would then almost never match) and let ts_rank order the hits.
  // Tokens are alphanumeric-only by construction, safe inside to_tsquery.
  // ponytail: 'english' config only; zh/ms questions need their own
  // tokenization (or pgvector) when those languages reach Ask.
  const terms = question
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (terms.length === 0) return [];
  const ranked = await pool.query(
    `SELECT t.id FROM unnest($1::text[], $2::text[]) AS t(id, text)
     WHERE to_tsvector('english', t.text) @@ to_tsquery('english', $3)
     ORDER BY ts_rank(to_tsvector('english', t.text), to_tsquery('english', $3)) DESC
     LIMIT 12`,
    [candidates.map((c) => c.id), candidates.map((c) => c.text), terms.join(" | ")],
  );
  const hits = new Set(ranked.rows.map((r) => r.id as string));
  return candidates.filter((c) => hits.has(c.id));
}

// All item texts of a summary, flattened into one searchable passage.
function summaryText(p: SummaryPayload): string {
  return Object.values(p)
    .filter(Array.isArray)
    .flat()
    .map((it) => (it as { text?: unknown }).text)
    .filter((t): t is string => typeof t === "string")
    .join(" ");
}

export async function askQuestion(
  pool: pg.Pool,
  answerer: AnswererPort,
  config: Config,
  userId: string,
  question: unknown,
  now: Date = new Date(),
): Promise<AskAnswer | "invalid"> {
  if (typeof question !== "string" || question.trim() === "" || question.length > 1000) {
    return "invalid";
  }
  const sources = await retrieveSources(pool, config, userId, question, now);
  if (sources.length === 0) return DONT_KNOW;
  const res = await answerer.answer({ question, sources });
  return validateAnswer(res.output, new Set(sources.map((s) => s.id)));
}
