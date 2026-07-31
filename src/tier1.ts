import type pg from "pg";
import type { GatewayPort } from "./gateway/port.ts";

// Tier 1 (spec §47–48): opt-in outbound to others. Tier 0 stays the default —
// nothing here runs unless the user explicitly authorized outbound and accepted
// the ban risk as theirs. The first message to a new number is the cold send
// carrying the handshake ask; further messages stay blocked until the recipient
// replies "Yes".

export const HANDSHAKE_SUFFIX =
  '\n\nReply "Yes" to keep receiving messages from this WALAO user.';

export async function enableTier1(
  pool: pg.Pool,
  userId: string,
  authorizationVersion: unknown,
): Promise<"authorization_required" | { tier1_enabled: true }> {
  if (typeof authorizationVersion !== "string" || authorizationVersion.length === 0)
    return "authorization_required";
  await pool.query(
    `UPDATE users SET tier1_authorization_version = $2,
                      tier1_enabled_at = COALESCE(tier1_enabled_at, now())
     WHERE id = $1`,
    [userId, authorizationVersion],
  );
  return { tier1_enabled: true };
}

export type OutboundResult =
  | "invalid"
  | "tier1_required"
  | "paused"
  | "not_connected"
  | "handshake_pending"
  | { sent: true; handshake: "pending" | "confirmed" };

export async function sendOutbound(
  pool: pg.Pool,
  gateway: GatewayPort,
  userId: string,
  recipient: unknown,
  text: unknown,
): Promise<OutboundResult> {
  if (typeof recipient !== "string" || recipient.length === 0) return "invalid";
  if (typeof text !== "string" || text.length === 0) return "invalid";

  const user = await pool.query(`SELECT paused, tier1_enabled_at FROM users WHERE id = $1`, [
    userId,
  ]);
  if (user.rows[0].paused) return "paused";
  if (!user.rows[0].tier1_enabled_at) return "tier1_required";

  const sess = await pool.query(
    `SELECT external_session_id FROM whatsapp_sessions
     WHERE user_id = $1 AND status = 'connected' LIMIT 1`,
    [userId],
  );
  if (sess.rows.length === 0) return "not_connected";
  const sessionExternalId = sess.rows[0].external_session_id as string;

  // First-ever message to this number: claim the handshake row, then send the
  // cold message with the "Yes" ask appended so the recipient knows how to
  // consent. The insert-first order makes a concurrent duplicate send lose.
  const ins = await pool.query(
    `INSERT INTO outbound_recipients (user_id, recipient_jid) VALUES ($1, $2)
     ON CONFLICT (user_id, recipient_jid) DO NOTHING
     RETURNING id`,
    [userId, recipient],
  );
  if ((ins.rowCount ?? 0) > 0) {
    try {
      await gateway.sendToRecipient(sessionExternalId, recipient, text + HANDSHAKE_SUFFIX);
    } catch (err) {
      // Send never left: undo the claim so the recipient isn't wedged pending
      // with no handshake message ever delivered.
      await pool.query(`DELETE FROM outbound_recipients WHERE id = $1`, [ins.rows[0].id]);
      throw err;
    }
    return { sent: true, handshake: "pending" };
  }

  const rec = await pool.query(
    `SELECT status FROM outbound_recipients WHERE user_id = $1 AND recipient_jid = $2`,
    [userId, recipient],
  );
  if (rec.rows[0].status !== "confirmed") return "handshake_pending";
  await gateway.sendToRecipient(sessionExternalId, recipient, text);
  return { sent: true, handshake: "confirmed" };
}

// Ingress hook: consume a DM from a known outbound recipient. Returns true when
// the JID belongs to one — the caller must then drop the event either way:
// recipient DMs are never stored and never registered as groups. Only an exact
// "Yes" (trimmed, case-insensitive) confirms; anything else leaves it pending.
export async function handleRecipientReply(
  pool: pg.Pool,
  userId: string,
  jid: string,
  text: string,
): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT id, status FROM outbound_recipients WHERE user_id = $1 AND recipient_jid = $2`,
    [userId, jid],
  );
  if (rows.length === 0) return false;
  if (rows[0].status === "pending" && text.trim().toLowerCase() === "yes") {
    await pool.query(
      `UPDATE outbound_recipients SET status = 'confirmed', confirmed_at = now() WHERE id = $1`,
      [rows[0].id],
    );
  }
  return true;
}
