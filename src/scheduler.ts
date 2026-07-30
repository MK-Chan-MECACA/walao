import type pg from "pg";

export const LANGUAGES = ["zh", "en", "ms"] as const;
export type Language = (typeof LANGUAGES)[number];

export type Schedule = {
  group_id: string;
  local_time: string;
  timezone: string;
  language: Language;
};

export type SetScheduleResult = Schedule | "not_found" | "not_enabled" | "invalid";

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

  const { rows } = await pool.query(
    `SELECT g.enabled FROM groups g
     JOIN whatsapp_sessions s ON s.id = g.session_id
     WHERE g.id = $2 AND s.user_id = $1`,
    [userId, groupId],
  );
  if (rows.length === 0) return "not_found";
  if (!rows[0].enabled) return "not_enabled";

  await pool.query(
    `INSERT INTO summary_schedules (group_id, local_time, timezone, language)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (group_id) DO UPDATE
       SET local_time = EXCLUDED.local_time,
           timezone   = EXCLUDED.timezone,
           language   = EXCLUDED.language`,
    [groupId, localTime, timezone, language],
  );
  return { group_id: groupId, local_time: localTime, timezone, language: language as Language };
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Local wall clock ('YYYY-MM-DD', 'HH:MM') of a UTC instant in an IANA zone.
// Intl carries the full tz database — correct across DST — so no dependency.
function localParts(instant: Date, timeZone: string): { date: string; time: string } {
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
export async function tickScheduler(pool: pg.Pool, now: Date = new Date()): Promise<SummaryJob[]> {
  const { rows } = await pool.query(
    `SELECT s.group_id, s.local_time, s.timezone, s.language, s.last_fired_at
     FROM summary_schedules s
     JOIN groups g ON g.id = s.group_id
     WHERE g.enabled`,
  );

  const jobs: SummaryJob[] = [];
  for (const r of rows) {
    const { date, time } = localParts(now, r.timezone);
    if (time < r.local_time) continue;
    if (r.last_fired_at && localParts(new Date(r.last_fired_at), r.timezone).date === date) {
      continue;
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
