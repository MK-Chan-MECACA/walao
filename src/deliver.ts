import type pg from "pg";
import type { GatewayPort } from "./gateway/port.ts";
import type { ActionItem, SummaryPayload } from "./summarize.ts";
import type { Config } from "./config.ts";
import { processingBlock } from "./block.ts";
import { buildTodayBrief } from "./brief.ts";
import { candidateKey, pickForToday, type PickerPort } from "./pick.ts";
import { isValidTimeZone, localParts } from "./scheduler.ts";

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

// Ticket 06: WALAO stopped being a source of message volume — no summary is
// direct-messaged per Group any more. The drain keeps its shape (claim a row,
// respect the Processing Block, mark it delivered) so nothing downstream has to
// learn a new state; it simply no longer touches the gateway. What the user
// receives is one digest a day, below.
export async function deliverSummaries(pool: pg.Pool): Promise<number> {
  let delivered = 0;
  // Summaries whose account is blocked this tick. They stay pending and are
  // simply not re-selected in this loop, so a block can't spin the drain.
  const blocked: string[] = [];
  for (;;) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `SELECT s.id, ws.user_id, g.id AS group_id
         FROM summaries s
         JOIN groups g ON g.id = s.group_id
         JOIN whatsapp_sessions ws ON ws.id = g.session_id
         WHERE s.delivered_at IS NULL AND NOT (s.id = ANY($1::uuid[]))
         ORDER BY s.created_at
         FOR UPDATE OF s SKIP LOCKED
         LIMIT 1`,
        [blocked],
      );
      if (rows.length === 0) {
        await client.query("COMMIT");
        break;
      }
      const r = rows[0];
      // Processing Block (ticket 17): delivery is a pipeline stage like any
      // other — halted, paused, disconnected or over-cap and the summary waits
      // for the next tick rather than being marked done.
      if (
        await processingBlock(client, r.user_id as string, {
          groupId: r.group_id as string,
          stage: "deliver",
        })
      ) {
        blocked.push(r.id as string);
        await client.query("COMMIT");
        continue;
      }
      await client.query(`UPDATE summaries SET delivered_at = now() WHERE id = $1`, [r.id]);
      await client.query("COMMIT");
      delivered++;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      // Ids only in routine logs — never message content.
      console.error("summary delivery failed:", err instanceof Error ? err.message : "error");
      break;
    } finally {
      client.release();
    }
  }
  return delivered;
}

// The one message a day. Numbered so it reads as a short list and not a dump,
// each item carrying the Group it came from, and one link for everything the
// message deliberately left out. A day with nothing in it says so — silence
// would be indistinguishable from WALAO being broken.
// ponytail: English regardless of Summary language, same as renderSummary.
export function renderDigest(
  headline: string,
  items: { text: string; group_name: string | null }[],
  appUrl: string,
): string {
  const lines = ["WALAO — today"];
  if (items.length === 0) {
    lines.push("", "Nothing needs you today.", "", `Everything else: ${appUrl}/today`);
    return lines.join("\n");
  }
  if (headline) lines.push("", headline);
  lines.push("");
  items.forEach((it, i) => lines.push(`${i + 1}. ${it.text} — ${it.group_name ?? "group"}`));
  lines.push("", `Everything else: ${appUrl}/today`);
  return lines.join("\n");
}

// Send the day's record, one Account per transaction, claimed with SKIP LOCKED
// like every other drain. delivered_at is the idempotency key: a crash between
// send and commit can duplicate the chat message but can never lose it, which
// is the same trade the per-Group path made.
export async function deliverDigests(
  pool: pg.Pool,
  gateway: GatewayPort,
  appUrl: string,
): Promise<number> {
  let sent = 0;
  const blocked: string[] = [];
  for (;;) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        // Only today's record. An Account blocked for a week owes one message
        // when it comes back, not seven — a stale pick is noise, not news.
        `SELECT b.user_id, b.day, b.headline, b.item_keys,
                (SELECT external_session_id FROM whatsapp_sessions
                  WHERE user_id = b.user_id AND status = 'connected'
                  ORDER BY created_at DESC LIMIT 1) AS session
         FROM briefs b
         WHERE b.delivered_at IS NULL AND b.due_at <= now()
           AND b.day >= (now() AT TIME ZONE 'utc')::date
           AND NOT (b.user_id = ANY($1::uuid[]))
         ORDER BY b.created_at
         FOR UPDATE OF b SKIP LOCKED
         LIMIT 1`,
        [blocked],
      );
      if (rows.length === 0) {
        await client.query("COMMIT");
        break;
      }
      const r = rows[0];
      // No connected Session is not a send with nowhere to go — it is no send.
      // The Processing Block says the same thing and more (halted, paused,
      // unpaid, over cap), and either way the row waits for the next tick.
      if (!r.session || (await processingBlock(client, r.user_id as string, { stage: "deliver" }))) {
        blocked.push(r.user_id as string);
        await client.query("COMMIT");
        continue;
      }

      // The picked keys are resolved back through the same Brief the pick was
      // made from, so a Summary purged in between simply has no entry left and
      // its item drops out silently rather than rendering as an error.
      const brief = await buildTodayBrief(pool, r.user_id as string);
      const byKey = new Map<string, { text: string; group_name: string | null }>();
      for (const bucket of ["needs_action", "decided", "worth_noting"] as const) {
        for (const item of brief[bucket]) {
          const first = item.sources[0];
          if (first) byKey.set(candidateKey(first), { text: item.text, group_name: first.group_name });
        }
      }
      const items = (r.item_keys as string[])
        .map((k) => byKey.get(k))
        .filter((v): v is { text: string; group_name: string | null } => v !== undefined);

      await gateway.sendToSelf(
        r.session as string,
        renderDigest(r.headline as string, items, appUrl),
      );
      await client.query(
        `UPDATE briefs SET delivered_at = now() WHERE user_id = $1 AND day = $2`,
        [r.user_id, r.day],
      );
      await client.query("COMMIT");
      sent++;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("digest delivery failed:", err instanceof Error ? err.message : "error");
      break; // gateway likely down; leave the rest for the next tick
    } finally {
      client.release();
    }
  }
  return sent;
}

// The digest clock. Two paths write the day's record — the web page when
// someone opens it, and this tick for the Accounts who never do — so an Account
// that lives entirely inside WhatsApp still gets its message. The placeholder
// row is claimed first: whoever wins the insert owns the day, and everyone else
// (including a re-tick a second later) is a no-op that spends no model call.
// ponytail: one query per tick over every connected Account. Filter it in SQL
// on the digest hour if the Account count ever makes the scan show.
export async function tickDigests(
  pool: pg.Pool,
  picker: PickerPort,
  config: Config,
  now: Date = new Date(),
): Promise<number> {
  const { rows } = await pool.query(
    `SELECT u.id, u.digest_time, u.digest_timezone FROM users u
     WHERE EXISTS (SELECT 1 FROM whatsapp_sessions
                    WHERE user_id = u.id AND status = 'connected')`,
  );
  let written = 0;
  for (const r of rows) {
    if (localParts(now, r.digest_timezone as string).time < (r.digest_time as string)) continue;
    // The day key stays the UTC day the Brief itself uses, so the web path and
    // this tick can never write two rows for what the user calls one day.
    const day = now.toISOString().slice(0, 10);
    const claim = await pool.query(
      `INSERT INTO briefs (user_id, day, input_hash, headline, item_keys)
       VALUES ($1, $2::date, '', '', '{}') ON CONFLICT (user_id, day) DO NOTHING`,
      [r.id, day],
    );
    if (claim.rowCount === 0) continue; // already recorded today, by either path
    written++;
    // Fills the placeholder in with the real pick. A quiet day never reaches the
    // model and leaves the row empty — which is what "nothing needs you" is.
    const brief = await buildTodayBrief(pool, r.id as string);
    await pickForToday(pool, picker, config, r.id as string, brief);
  }
  return written;
}

export type Digest = { digest_time: string; timezone: string };

export async function getDigest(pool: pg.Pool, userId: string): Promise<Digest> {
  const { rows } = await pool.query(
    `SELECT digest_time, digest_timezone FROM users WHERE id = $1`,
    [userId],
  );
  return { digest_time: rows[0].digest_time, timezone: rows[0].digest_timezone };
}

// Same validation as the per-Group schedule, for the same reason: an unparseable
// zone would make the clock silently never fire.
export async function setDigest(
  pool: pg.Pool,
  userId: string,
  input: unknown,
): Promise<Digest | "invalid"> {
  const b = (input ?? {}) as Record<string, unknown>;
  const time = b.digest_time;
  const timezone = b.timezone;
  if (typeof time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return "invalid";
  if (typeof timezone !== "string" || !isValidTimeZone(timezone)) return "invalid";
  await pool.query(`UPDATE users SET digest_time = $2, digest_timezone = $3 WHERE id = $1`, [
    userId,
    time,
    timezone,
  ]);
  return { digest_time: time, timezone };
}
