import type pg from "pg";
import type { GatewayPort } from "./gateway/port.ts";
import type { Config } from "./config.ts";
import { processingBlock } from "./block.ts";
import { validatePick, type PickerPort } from "./pick.ts";
import { accountKey } from "./accounts.ts";
import { decrypt } from "./crypto.ts";
import { allow, type Limit } from "./limits.ts";

// Ticket 08 — the only unprompted interruption in the product. Somebody
// @mentions the Account holder with something that genuinely needs them and
// they hear about it in minutes; somebody @mentions them to say thank you and
// they hear nothing at all.
//
// The judgement is the same PickerPort call the daily message is built from,
// run over a single candidate: an empty result means this mention needs
// nothing. That reuse is the design, not a shortcut — a second prompt for the
// same question would drift from the first, and the ping and the digest would
// start disagreeing about what a "thanks" is.

// The backstop, not the judgement: one chaotic Group cannot flood anyone. It
// counts judgements rather than sends, and is spent BEFORE the model call, so a
// mention past the ceiling costs no tokens either. Past it the mention is
// resolved rather than left queued — the item is not lost, it simply waits for
// the daily message like everything else, which is a delay and not a loss.
export const PING_PER_HOUR: Limit = { limit: 5, windowMs: 3600_000 };

// A ping names the Group it came from — without it, "you're needed" is a riddle.
export function renderPing(groupName: string | null, headline: string, appUrl: string): string {
  return [
    `WALAO — you were tagged in ${groupName ?? "a group"}`,
    "",
    headline || "Something there needs you.",
    "",
    `Everything else: ${appUrl}/today`,
  ].join("\n");
}

// Judge the queue and ping what survives. Same drain shape as the digest send:
// one Account per transaction, claimed with SKIP LOCKED, resolved_at as the
// idempotency key. An Account that cannot be sent to right now — blocked,
// halted, paused, unpaid, over cap, or with no connected Session — has its rows
// left queued and is skipped for the rest of the pass, so a block cannot spin
// the loop and cannot silently eat a mention either.
export async function tickPings(
  pool: pg.Pool,
  gateway: GatewayPort,
  picker: PickerPort,
  config: Config,
): Promise<number> {
  let sent = 0;
  const blocked: string[] = [];
  for (;;) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        // The message's own Session is the one that would carry the ping: one
        // Session per Account (ADR-0001), so if that one is not connected there
        // is nowhere to send. self_name rides along for the picker input.
        `SELECT p.message_id, p.user_id, m.body_ciphertext, g.name AS group_name,
                ws.external_session_id AS session, ws.status, ws.self_name
         FROM mention_pings p
         JOIN messages m ON m.id = p.message_id
         JOIN groups g ON g.id = m.group_id
         JOIN whatsapp_sessions ws ON ws.id = m.session_id
         WHERE p.resolved_at IS NULL AND NOT (p.user_id = ANY($1::uuid[]))
         ORDER BY p.created_at
         FOR UPDATE OF p SKIP LOCKED
         LIMIT 1`,
        [blocked],
      );
      if (rows.length === 0) {
        await client.query("COMMIT");
        break;
      }
      const r = rows[0];
      if (
        r.status !== "connected" ||
        (await processingBlock(client, r.user_id as string, { stage: "deliver" }))
      ) {
        blocked.push(r.user_id as string);
        await client.query("COMMIT");
        continue;
      }

      // Counted on the pool, not this transaction: a spent slot must survive a
      // rollback further down, or a failing model call would refund the quota
      // it was meant to cap.
      if (await allow(pool, `ping:${r.user_id}`, PING_PER_HOUR)) {
        const key = await accountKey(client, config, r.user_id as string);
        const text = decrypt(r.body_ciphertext as Buffer, key);
        const result = await picker.pick({
          candidates: [
            {
              key: r.message_id as string,
              text,
              group_name: r.group_name as string | null,
              // tagged is deterministic and true by construction — this row
              // exists because the mention matched. bucket is what the judgement
              // is being asked about: does this need them?
              bucket: "needs_action",
              tagged: true,
            },
          ],
          self_name: r.self_name as string | null,
        });
        const pick = validatePick(result.output, new Set([r.message_id as string]));
        if (pick.keys.length > 0) {
          await gateway.sendToSelf(
            r.session as string,
            renderPing(r.group_name as string | null, pick.headline, config.appUrl),
          );
          sent++;
        }
      }
      await client.query(`UPDATE mention_pings SET resolved_at = now() WHERE message_id = $1`, [
        r.message_id,
      ]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      // Ids only in routine logs — never message content.
      console.error("ping failed:", err instanceof Error ? err.message : "error");
      break; // model or gateway is unhappy; the row stays queued for the next tick
    } finally {
      client.release();
    }
  }
  return sent;
}
