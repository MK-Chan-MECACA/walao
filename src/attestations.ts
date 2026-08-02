import type pg from "pg";

// Ticket 19 (spec §6, §8, §20-21, §77, §205-210): one table for every versioned
// affirmation. The version stored is the version of the wording that was shown,
// so changing the copy is a new version rather than a silent edit.

export type AttestationKind =
  | "data_processing_terms"
  | "ban_risk"
  | "group_responsibility"
  | "tier1_outbound";

// Shown before signup and echoed by POST /v1/signup. Spec §77 + §254: the
// terms name the region and say plainly that summarisation leaves it.
export const DATA_PROCESSING_TERMS = {
  version: "2026-08-01",
  text:
    "WALAO runs in Singapore (ap-southeast-1) and stores your data there. Messages " +
    "are stored only from groups you explicitly enable, encrypted at rest, and raw " +
    "messages are deleted at the end of your retention window (1-30 days, 7 by " +
    "default). To write a summary, WALAO sends that group's message text to " +
    "Anthropic, an AI provider outside Singapore, which processes it and does not " +
    "keep it. Nobody at WALAO can read your messages or summaries unless you opt " +
    "in to quality review. You can export everything or delete your account at any " +
    "time; deleting destroys your encryption key, so what is left becomes " +
    "unreadable.",
};

// A pool or an open transaction client — group enable writes its Attestation
// inside the same transaction as the flag flip (spec §209).
type Queryable = Pick<pg.Pool, "query">;

// "group_disabled" is the audit row for turning a Group off. It is not an
// affirmation, so it carries no version — it lives here to keep one trail.
export function recordAttestation(
  db: Queryable,
  userId: string,
  kind: AttestationKind | "group_disabled",
  version: string | null,
  groupId: string | null = null,
): Promise<unknown> {
  return db.query(
    `INSERT INTO attestations (user_id, kind, version, group_id) VALUES ($1, $2, $3, $4)`,
    [userId, kind, version, groupId],
  );
}

export type Attestation = {
  id: string;
  kind: string;
  version: string | null;
  group_id: string | null;
  created_at: string;
};

// Spec §20: the Account holder can audit their own consent trail.
export async function listAttestations(
  pool: pg.Pool,
  userId: string,
): Promise<Attestation[]> {
  const { rows } = await pool.query(
    `SELECT id, kind, version, group_id, created_at
     FROM attestations
     WHERE user_id = $1
     ORDER BY created_at, id`,
    [userId],
  );
  return rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() }));
}
