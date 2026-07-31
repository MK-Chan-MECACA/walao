import type pg from "pg";

// Product-wide halt switch (ticket 14, spec §49): flipped by the operator when
// a WhatsApp/Meta legal notice arrives. While halted, all gateway activity
// stops — webhooks are refused, deliveries and outbound sends are blocked, and
// pairing is refused. State lives in a single-row table so every process sees
// the flip immediately.

export async function isHalted(pool: pg.Pool): Promise<boolean> {
  // ponytail: one DB read per guarded request; cache with a short TTL if the
  // webhook path ever shows up in load.
  const { rows } = await pool.query(`SELECT halted FROM system_halt`);
  return rows[0]?.halted === true;
}

// Halting opens a coverage gap (reason 'halted') for every session that doesn't
// already have one open, so summary windows overlapping the halt are flagged
// incomplete by the existing gap-detection path. Un-halting closes exactly the
// halt gaps — a session that was disconnected before the halt keeps its own
// open gap untouched.
export async function setHalted(pool: pg.Pool, halted: boolean): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const res = await client.query(
      `UPDATE system_halt SET halted = $1, changed_at = now() WHERE halted <> $1 RETURNING halted`,
      [halted],
    );
    if (res.rowCount === 0) {
      await client.query("COMMIT"); // already in the requested state — idempotent
      return;
    }
    if (halted) {
      await client.query(
        `INSERT INTO coverage_gaps (session_id, reason)
         SELECT s.id, 'halted' FROM whatsapp_sessions s
         WHERE NOT EXISTS
           (SELECT 1 FROM coverage_gaps WHERE session_id = s.id AND ended_at IS NULL)`,
      );
    } else {
      await client.query(
        `UPDATE coverage_gaps SET ended_at = now() WHERE reason = 'halted' AND ended_at IS NULL`,
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
