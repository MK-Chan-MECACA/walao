import type pg from "pg";
import { processingBlock } from "./block.ts";
import { getPlan } from "./billing.ts";

export const LANGUAGES = ["zh", "en", "ms"] as const;
export type Language = (typeof LANGUAGES)[number];

// Ticket 7: how often a Group's window closes, and — the part the user is
// actually choosing — whether it is allowed to interrupt them. null is daily.
export const MAX_INTERVAL_HOURS = 12;

export type Schedule = {
  group_id: string;
  local_time: string;
  timezone: string;
  language: Language;
  interval_hours: number | null;
};

export type SetScheduleResult =
  | Schedule
  | "not_found"
  | "not_enabled"
  | "invalid"
  | "payment_required";

// Schedules are settable for enabled groups only; the tenant boundary is the
// same session join used everywhere else. Upsert keeps last_fired_at, so
// editing a schedule never re-fires an already-covered window.
export async function setSchedule(
  pool: pg.Pool,
  userId: string,
  groupId: string,
  input: unknown,
): Promise<SetScheduleResult> {
  const b = (input ?? {}) as Record<string, unknown>;
  const { local_time: localTime, timezone, language } = b;
  if (typeof localTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(localTime)) {
    return "invalid";
  }
  if (typeof timezone !== "string" || !isValidTimeZone(timezone)) return "invalid";
  if (typeof language !== "string" || !(LANGUAGES as readonly string[]).includes(language)) {
    return "invalid";
  }
  const interval = b.interval_hours ?? null;
  if (
    interval !== null &&
    (!Number.isInteger(interval) || (interval as number) < 1 || (interval as number) > MAX_INTERVAL_HOURS)
  ) {
    return "invalid";
  }

  const { rows } = await pool.query(
    `SELECT g.enabled FROM groups g
     JOIN whatsapp_sessions s ON s.id = g.session_id
     WHERE g.id = $2 AND s.user_id = $1`,
    [userId, groupId],
  );
  if (rows.length === 0) return "not_found";
  if (!rows[0].enabled) return "not_enabled";
  // Refused rather than silently capped, and refused before anything is
  // written: a setting that says "every four hours" while quietly firing once
  // is worse than not offering it. Free's five Summaries a day cannot cover
  // one Group's six windows, let alone the rest of the Account's.
  if (interval !== null && (await getPlan(pool, userId)) === "free") return "payment_required";

  await pool.query(
    `INSERT INTO summary_schedules (group_id, local_time, timezone, language, interval_hours)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (group_id) DO UPDATE
       SET local_time     = EXCLUDED.local_time,
           timezone       = EXCLUDED.timezone,
           language       = EXCLUDED.language,
           interval_hours = EXCLUDED.interval_hours`,
    [groupId, localTime, timezone, language, interval],
  );
  return {
    group_id: groupId,
    local_time: localTime,
    timezone,
    language: language as Language,
    interval_hours: interval as number | null,
  };
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Local wall clock ('YYYY-MM-DD', 'HH:MM') of a UTC instant in an IANA zone.
// Intl carries the full tz database — correct across DST — so no dependency.
export function localParts(instant: Date, timeZone: string): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export type SummaryJob = {
  group_id: string;
  language: Language;
  window_start: string;
  window_end: string;
};

// Scheduler tick — the ticket-5 test seam: schedule config + clock in, job
// emissions out. A schedule is due when the group's local wall clock has
// reached local_time and it hasn't fired on this local calendar date yet.
// That rule is DST-proof for free: a spring-forward time that doesn't exist
// fires at the next tick after the jump, and a fall-back repeated hour can't
// double-fire because the local date already matches.
//
// A due-but-quiet window (no new messages) closes without emitting a job — no
// AI cost — and the next window starts where this one ended. Disabled groups
// are re-checked at fire time, so disabling also silences an existing schedule.
//
// A Group on an interval (ticket 7) ignores local time entirely and compares
// elapsed duration instead, so it fires several times a day by design — DST is
// irrelevant to it for the same reason.
export async function tickScheduler(pool: pg.Pool, now: Date = new Date()): Promise<SummaryJob[]> {
  const { rows } = await pool.query(
    `SELECT s.group_id, s.local_time, s.timezone, s.language, s.last_fired_at,
            s.interval_hours, ws.user_id
     FROM summary_schedules s
     JOIN groups g ON g.id = s.group_id
     JOIN whatsapp_sessions ws ON ws.id = g.session_id
     WHERE g.enabled`,
  );

  const jobs: SummaryJob[] = [];
  for (const r of rows) {
    // Processing Block (ticket 17): checked before last_fired_at moves, so a
    // block postpones the window rather than consuming it.
    if (await processingBlock(pool, r.user_id, { groupId: r.group_id, stage: "schedule" }))
      continue;
    if (r.interval_hours) {
      const elapsed = now.getTime() - new Date(r.last_fired_at ?? 0).getTime();
      if (r.last_fired_at && elapsed < r.interval_hours * 3600_000) continue;
    } else {
      const { date, time } = localParts(now, r.timezone);
      if (time < r.local_time) continue;
      if (r.last_fired_at && localParts(new Date(r.last_fired_at), r.timezone).date === date) {
        continue;
      }
    }

    // First-ever window covers everything stored so far; after that, windows
    // tile exactly: (previous close, this close].
    const windowStart: Date = r.last_fired_at ?? new Date(0);
    await pool.query(`UPDATE summary_schedules SET last_fired_at = $2 WHERE group_id = $1`, [
      r.group_id,
      now,
    ]);

    const count = await pool.query(
      `SELECT count(*)::int AS n FROM messages
       WHERE group_id = $1 AND sent_at > $2 AND sent_at <= $3`,
      [r.group_id, windowStart, now],
    );
    if (count.rows[0].n === 0) continue;

    await pool.query(
      `INSERT INTO summary_jobs (group_id, language, window_start, window_end)
       VALUES ($1, $2, $3, $4)`,
      [r.group_id, r.language, windowStart, now],
    );
    jobs.push({
      group_id: r.group_id,
      language: r.language,
      window_start: windowStart.toISOString(),
      window_end: now.toISOString(),
    });
  }
  return jobs;
}
