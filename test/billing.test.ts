import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { buildEvent, makeHarness, type Harness } from "./helpers.ts";
import { tickScheduler } from "../src/scheduler.ts";
import { ATTESTATION_VERSION } from "../src/subscriptions.ts";
import { PLANS } from "../src/billing.ts";
import { encrypt } from "../src/crypto.ts";

// Ticket 15: pricing & usage (spec §51-53). Whole-system seam: plan caps hit at
// group enable, message store, and summary generation; /v1/usage shows plan,
// limits, and per-group credit burn.
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

test("usage endpoint: plan, limits, burn, and per-group credits visible", async () => {
  const userId = await h.seedUser("u1");
  const sessionId = await h.seedSession(userId, "sess-u1");
  const g1 = await h.seedGroup(sessionId, "g1@g.us");
  await h.seedGroup(sessionId, "g2@g.us");
  await h.seedMessage(g1, "m1", new Date().toISOString());
  await h.pool.query(
    `INSERT INTO summaries
       (user_id, group_id, language, window_start, window_end, payload,
        model, prompt_version, input_tokens, output_tokens, duration_ms)
     VALUES ($1, $2, 'en', now() - interval '1 hour', now(), '{}', 't', 't', 0, 0, 0)`,
    [userId, g1],
  );

  const res = await h.api("u1", "GET", "/v1/usage");
  assert.equal(res.status, 200);
  const body = res.body as Record<string, any>;
  assert.equal(body.plan, "free");
  assert.deepEqual(body.limits, PLANS.free);
  assert.equal(body.usage.enabled_groups, 2);
  assert.equal(body.usage.messages_today, 1);
  assert.equal(body.usage.credits_today, 1);
  assert.deepEqual(body.groups, [{ group_id: g1, name: null, credits_30d: 1 }]);
});

test("group cap: free stops at 3, re-attest at cap still works, pro raises it", async () => {
  const userId = await h.seedUser("u2");
  const sessionId = await h.seedSession(userId, "sess-u2");
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) ids.push(await h.seedGroup(sessionId, `g${i}@g.us`, false));

  const enable = (id: string) =>
    h.api("u2", "POST", `/v1/groups/${id}/enable`, { attestation_version: ATTESTATION_VERSION });

  for (let i = 0; i < 3; i++) assert.equal((await enable(ids[i])).status, 200);
  const fourth = await enable(ids[3]);
  assert.equal(fourth.status, 403);
  assert.deepEqual(fourth.body, { error: "plan_limit" });
  const { rows } = await h.pool.query(`SELECT enabled FROM groups WHERE id = $1`, [ids[3]]);
  assert.equal(rows[0].enabled, false);

  // Re-attesting an already-enabled group at the cap is not a new group.
  assert.equal((await enable(ids[0])).status, 200);

  await h.pool.query(`UPDATE users SET plan = 'pro' WHERE id = $1`, [userId]);
  assert.equal((await enable(ids[3])).status, 200);
});

test("message cap: over-cap events skipped with a coverage gap, under-cap store closes it", async () => {
  const userId = await h.seedUser("u3");
  const sessionId = await h.seedSession(userId, "sess-u3");
  const groupId = await h.seedGroup(sessionId, "group-1@g.us"); // buildEvent's default chatId
  await h.pool.query(
    `INSERT INTO messages
       (user_id, session_id, group_id, external_id, sent_at, from_me, body_ciphertext, expires_at)
     SELECT $1, $2, $3, 'bulk-' || i, now(), false, $4, now() + interval '7 days'
     FROM generate_series(1, $5::int) i`,
    [userId, sessionId, groupId, encrypt("x", h.config.encKey), PLANS.free.max_messages_per_day],
  );

  assert.equal(
    await h.postWebhook(buildEvent({ session: "sess-u3", id: "over-cap" })),
    202,
  );
  assert.equal(await h.drain(), 0); // skipped, not stored
  const gaps = await h.pool.query(
    `SELECT reason, ended_at FROM coverage_gaps WHERE session_id = $1`,
    [sessionId],
  );
  assert.deepEqual(gaps.rows, [{ reason: "plan_limit", ended_at: null }]);

  // Next UTC day (simulated by aging the bulk rows): storing resumes, gap closes.
  await h.pool.query(`UPDATE messages SET created_at = created_at - interval '1 day'`);
  assert.equal(await h.postWebhook(buildEvent({ session: "sess-u3", id: "under-cap" })), 202);
  assert.equal(await h.drain(), 1);
  const closed = await h.pool.query(
    `SELECT count(*)::int AS n FROM coverage_gaps WHERE session_id = $1 AND ended_at IS NULL`,
    [sessionId],
  );
  assert.equal(closed.rows[0].n, 0);
});

test("AI cap: at the daily credit limit a job parks as 'capped' and the summarizer is never called", async () => {
  const userId = await h.seedUser("u4");
  const sessionId = await h.seedSession(userId, "sess-u4");
  const groupId = await h.seedGroup(sessionId, "g1@g.us");
  await h.api("u4", "PUT", `/v1/groups/${groupId}/schedule`, {
    local_time: "09:00",
    timezone: "Asia/Kuala_Lumpur",
    language: "en",
  });
  await h.seedMessage(groupId, "m1", "2026-07-30T00:30:00Z", { text: "hello" });
  await h.pool.query(
    `INSERT INTO summaries
       (user_id, group_id, language, window_start, window_end, payload,
        model, prompt_version, input_tokens, output_tokens, duration_ms)
     SELECT $1, $2, 'en', now() - interval '1 hour', now(), '{}', 't', 't', 0, 0, 0
     FROM generate_series(1, $3::int)`,
    [userId, groupId, PLANS.free.max_summaries_per_day],
  );

  assert.equal((await tickScheduler(h.pool, T("2026-07-30T01:00:00Z"))).length, 1);
  await h.summarize();
  assert.equal(h.summarizer.calls.length, 0);
  const jobs = await h.pool.query(`SELECT status FROM summary_jobs`);
  assert.deepEqual(jobs.rows, [{ status: "capped" }]);
  const res = await h.api("u4", "GET", "/v1/usage");
  assert.equal((res.body as any).usage.credits_today, PLANS.free.max_summaries_per_day);
});
