import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, type Harness } from "./helpers.ts";
import { tickScheduler } from "../src/scheduler.ts";

// Ticket 5: scheduler seam — schedule config + controlled clock in, job
// emissions out. The clock is the injectable `now` of tickScheduler; messages
// are seeded with controlled sent_at (the webhook path is covered elsewhere and
// its freshness guard rightly rejects synthetic past timestamps).
let h: Harness;

before(async () => {
  h = await makeHarness();
});
after(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.reset();
});

const T = (iso: string) => new Date(iso);

async function seedTenant(
  token: string,
  opts: { jid?: string; enabled?: boolean } = {},
): Promise<{ groupId: string }> {
  const userId = await h.seedUser(token);
  const sessionId = await h.seedSession(userId, `sess-${token}`);
  const groupId = await h.seedGroup(sessionId, opts.jid ?? "group-1@g.us", opts.enabled ?? true);
  return { groupId };
}

test("schedule settable via API for enabled groups only, with validation", async () => {
  const token = "tok";
  const { groupId } = await seedTenant(token);
  const { groupId: disabledId } = await seedTenant("tok-b", { jid: "g2@g.us", enabled: false });

  const ok = await h.api(token, "PUT", `/v1/groups/${groupId}/schedule`, {
    local_time: "09:00",
    timezone: "Asia/Kuala_Lumpur",
    language: "zh",
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, {
    group_id: groupId,
    local_time: "09:00",
    timezone: "Asia/Kuala_Lumpur",
    language: "zh",
    interval_hours: null, // daily: the Group never interrupts
  });

  // Disabled group: rejected. Other tenant's disabled group id via this token: 404.
  const disabled = await h.api("tok-b", "PUT", `/v1/groups/${disabledId}/schedule`, {
    local_time: "09:00",
    timezone: "Asia/Kuala_Lumpur",
    language: "en",
  });
  assert.equal(disabled.status, 400);
  assert.deepEqual(disabled.body, { error: "not_enabled" });
  assert.equal(
    (
      await h.api(token, "PUT", `/v1/groups/${disabledId}/schedule`, {
        local_time: "09:00",
        timezone: "Asia/Kuala_Lumpur",
        language: "en",
      })
    ).status,
    404,
  );

  // Bad time / timezone / language all rejected.
  for (const bad of [
    { local_time: "9:00", timezone: "Asia/Kuala_Lumpur", language: "zh" },
    { local_time: "25:00", timezone: "Asia/Kuala_Lumpur", language: "zh" },
    { local_time: "09:00", timezone: "Mars/Olympus_Mons", language: "zh" },
    { local_time: "09:00", timezone: "Asia/Kuala_Lumpur", language: "fr" },
  ]) {
    const res = await h.api(token, "PUT", `/v1/groups/${groupId}/schedule`, bad);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "invalid_schedule" });
  }

  // Ticket 7: a cadence that isn't a whole number of hours in range is refused
  // the same way — before the Plan is even consulted.
  for (const bad of [0, 13, 2.5, "4"]) {
    const res = await h.api(token, "PUT", `/v1/groups/${groupId}/schedule`, {
      local_time: "09:00",
      timezone: "Asia/Kuala_Lumpur",
      language: "zh",
      interval_hours: bad,
    });
    assert.equal(res.status, 400, String(bad));
  }
});

// Ticket 7: the cadence is an interruption budget. Daily leaves the Group alone;
// an interval lets it close a window every N hours and push what it finds.
test("an interval Group fires again the same day once its interval has elapsed", async () => {
  const token = "tok";
  const { groupId } = await seedTenant(token);
  await h.pool.query(`UPDATE users SET plan = 'pro'`);
  const set = await h.api(token, "PUT", `/v1/groups/${groupId}/schedule`, {
    local_time: "09:00",
    timezone: "Asia/Kuala_Lumpur",
    language: "en",
    interval_hours: 4,
  });
  assert.equal(set.status, 200);
  assert.equal((set.body as { interval_hours: number }).interval_hours, 4);

  // Local time is ignored entirely: 02:00 KL is a window like any other.
  await h.seedMessage(groupId, "m1", "2026-07-29T17:30:00Z");
  assert.equal((await tickScheduler(h.pool, T("2026-07-29T18:00:00Z"))).length, 1);

  // Before the interval has elapsed: nothing, even with a fresh message.
  await h.seedMessage(groupId, "m2", "2026-07-29T19:00:00Z");
  assert.deepEqual(await tickScheduler(h.pool, T("2026-07-29T21:59:00Z")), []);

  // Once it has: a second window the same local day, tiling from the last close.
  const second = await tickScheduler(h.pool, T("2026-07-29T22:00:00Z"));
  assert.equal(second.length, 1);
  assert.equal(second[0].window_start, "2026-07-29T18:00:00.000Z");

  // A window with nothing in it still closes, and costs no AI call.
  assert.deepEqual(await tickScheduler(h.pool, T("2026-07-30T02:00:00Z")), []);
});

test("an interval cadence is refused on Free, and writes no schedule at all", async () => {
  const token = "tok";
  const { groupId } = await seedTenant(token);

  const refused = await h.api(token, "PUT", `/v1/groups/${groupId}/schedule`, {
    local_time: "09:00",
    timezone: "Asia/Kuala_Lumpur",
    language: "en",
    interval_hours: 4,
  });
  assert.equal(refused.status, 402);
  assert.deepEqual(refused.body, { error: "payment_required" });

  // Left exactly as it was: no row, so nothing fires at all.
  const { rows } = await h.pool.query(`SELECT 1 FROM summary_schedules`);
  assert.equal(rows.length, 0);
  await h.seedMessage(groupId, "m1", "2026-07-29T17:30:00Z");
  assert.deepEqual(await tickScheduler(h.pool, T("2026-07-29T18:00:00Z")), []);

  // Daily on the same Group is not refused — only the interruption is paid for.
  assert.equal(
    (
      await h.api(token, "PUT", `/v1/groups/${groupId}/schedule`, {
        local_time: "09:00",
        timezone: "Asia/Kuala_Lumpur",
        language: "en",
      })
    ).status,
    200,
  );
});

test("advancing the clock to the local time emits exactly one job per window", async () => {
  const token = "tok";
  const { groupId } = await seedTenant(token);
  await h.api(token, "PUT", `/v1/groups/${groupId}/schedule`, {
    local_time: "09:00",
    timezone: "Asia/Kuala_Lumpur",
    language: "zh",
  });
  await h.seedMessage(groupId, "m1", "2026-07-30T00:30:00Z");

  // 08:59 local (KL = UTC+8): not yet.
  assert.deepEqual(await tickScheduler(h.pool, T("2026-07-30T00:59:00Z")), []);

  // 09:00 local: exactly one job, in the configured language, covering m1.
  const jobs = await tickScheduler(h.pool, T("2026-07-30T01:00:00Z"));
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].group_id, groupId);
  assert.equal(jobs[0].language, "zh");
  assert.equal(jobs[0].window_end, "2026-07-30T01:00:00.000Z");

  // Later ticks the same local day: nothing.
  assert.deepEqual(await tickScheduler(h.pool, T("2026-07-30T01:00:30Z")), []);
  assert.deepEqual(await tickScheduler(h.pool, T("2026-07-30T05:00:00Z")), []);

  // Next day with a new message: one more job, window tiling from the last close.
  await h.seedMessage(groupId, "m2", "2026-07-31T00:30:00Z");
  const day2 = await tickScheduler(h.pool, T("2026-07-31T01:00:00Z"));
  assert.equal(day2.length, 1);
  assert.equal(day2[0].window_start, "2026-07-30T01:00:00.000Z");
});

test("a quiet window produces no job, and disabling silences the schedule", async () => {
  const token = "tok";
  const { groupId } = await seedTenant(token);
  await h.api(token, "PUT", `/v1/groups/${groupId}/schedule`, {
    local_time: "09:00",
    timezone: "Asia/Kuala_Lumpur",
    language: "en",
  });

  // No messages at all: due tick emits nothing, and doesn't retry all day.
  assert.deepEqual(await tickScheduler(h.pool, T("2026-07-30T01:00:00Z")), []);
  assert.deepEqual(await tickScheduler(h.pool, T("2026-07-30T02:00:00Z")), []);

  // Next day a message lands in the new window: fires normally again.
  await h.seedMessage(groupId, "m1", "2026-07-31T00:30:00Z");
  assert.equal((await tickScheduler(h.pool, T("2026-07-31T01:00:00Z"))).length, 1);

  // Disable the group: schedule survives in the table but never fires.
  await h.api(token, "POST", `/v1/groups/${groupId}/disable`);
  await h.seedMessage(groupId, "m2", "2026-07-31T02:00:00Z");
  assert.deepEqual(await tickScheduler(h.pool, T("2026-08-01T01:00:00Z")), []);
});

test("DST spring forward: a nonexistent 02:30 fires at 03:00 local, once", async () => {
  // America/New_York 2026-03-08: clocks jump 02:00 EST -> 03:00 EDT; 02:30 never exists.
  const token = "tok";
  const { groupId } = await seedTenant(token);
  await h.api(token, "PUT", `/v1/groups/${groupId}/schedule`, {
    local_time: "02:30",
    timezone: "America/New_York",
    language: "en",
  });
  await h.seedMessage(groupId, "m1", "2026-03-08T05:30:00Z");

  // 01:59 EST (06:59Z): before the (skipped) 02:30.
  assert.deepEqual(await tickScheduler(h.pool, T("2026-03-08T06:59:00Z")), []);
  // 03:00 EDT (07:00Z): first instant past the jump — fires.
  assert.equal((await tickScheduler(h.pool, T("2026-03-08T07:00:00Z"))).length, 1);
  // Still 2026-03-08 locally: no double fire.
  assert.deepEqual(await tickScheduler(h.pool, T("2026-03-08T12:00:00Z")), []);
});

test("DST fall back: the repeated 01:30 hour fires exactly once", async () => {
  // America/New_York 2026-11-01: 01:30 occurs twice (EDT 05:30Z, then EST 06:30Z).
  const token = "tok";
  const { groupId } = await seedTenant(token);
  await h.api(token, "PUT", `/v1/groups/${groupId}/schedule`, {
    local_time: "01:30",
    timezone: "America/New_York",
    language: "ms",
  });
  await h.seedMessage(groupId, "m1", "2026-11-01T05:00:00Z");

  assert.deepEqual(await tickScheduler(h.pool, T("2026-11-01T05:29:00Z")), []);
  assert.equal((await tickScheduler(h.pool, T("2026-11-01T05:30:00Z"))).length, 1);
  // Second 01:30 of the day (EST): same local date, no second job.
  assert.deepEqual(await tickScheduler(h.pool, T("2026-11-01T06:30:00Z")), []);
});

test("cross-timezone schedules fire at each group's own local time", async () => {
  const token = "tok";
  const userId = await h.seedUser(token);
  const sessionId = await h.seedSession(userId, "sess-x");
  const kl = await h.seedGroup(sessionId, "kl@g.us");
  const ny = await h.seedGroup(sessionId, "ny@g.us");
  await h.api(token, "PUT", `/v1/groups/${kl}/schedule`, {
    local_time: "09:00",
    timezone: "Asia/Kuala_Lumpur",
    language: "zh",
  });
  await h.api(token, "PUT", `/v1/groups/${ny}/schedule`, {
    local_time: "09:00",
    timezone: "America/New_York",
    language: "en",
  });

  // Baseline tick before any messages: closes NY's already-passed Jul 29 window
  // quietly so the assertions below are purely about Jul 30 local times.
  assert.deepEqual(await tickScheduler(h.pool, T("2026-07-29T23:00:00Z")), []);

  await h.seedMessage(kl, "k1", "2026-07-30T00:30:00Z");
  await h.seedMessage(ny, "n1", "2026-07-30T00:30:00Z");

  // 01:00Z = 09:00 in KL, 21:00 Jul 29 in New York: only KL fires.
  const first = await tickScheduler(h.pool, T("2026-07-30T01:00:00Z"));
  assert.deepEqual(
    first.map((j) => [j.group_id, j.language]),
    [[kl, "zh"]],
  );

  // 13:00Z = 09:00 EDT in New York: only NY fires.
  const second = await tickScheduler(h.pool, T("2026-07-30T13:00:00Z"));
  assert.deepEqual(
    second.map((j) => [j.group_id, j.language]),
    [[ny, "en"]],
  );
});
