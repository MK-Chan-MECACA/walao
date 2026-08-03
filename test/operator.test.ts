import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, type Harness } from "./helpers.ts";
import { PLANS } from "../src/billing.ts";

// Ticket 28: the Operator console (spec §105, §108-109, §249). Whole-system
// seam: an Operator reads an Account's metadata with the operator secret and
// changes its Plan directly, and never sees a message or Summary body.
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

test("an Operator sees an Account's counts, jobs, connections and tokens — and no bodies", async () => {
  const userId = await h.seedUser("o1");
  const sessionId = await h.seedSession(userId, "sess-o1");
  const groupId = await h.seedGroup(sessionId, "og1@g.us");
  await h.seedGroup(sessionId, "og2@g.us", false);
  await h.seedMessage(groupId, "om1", new Date().toISOString(), { text: "kopi money lah" });
  const summaryId = await h.seedSummary(userId, groupId, {
    highlights: [{ text: "deposit paid", source_message_ids: [] }],
  });
  await h.pool.query(`UPDATE summaries SET input_tokens = 900, output_tokens = 120 WHERE id = $1`, [
    summaryId,
  ]);
  await h.pool.query(
    `INSERT INTO summary_jobs (group_id, language, window_start, window_end, status)
     VALUES ($1, 'en', now() - interval '1 hour', now(), 'pending')`,
    [groupId],
  );

  const res = await h.op("GET", `/admin/accounts/${userId}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;

  assert.equal(body.account.id, userId);
  assert.equal(body.account.plan, "free");
  assert.equal(body.account.unpaid, false);
  assert.deepEqual(body.counts, {
    sessions: 1,
    groups: 2,
    groups_enabled: 1,
    messages: 1,
    summaries: 1,
    reminders: 0,
    memories: 0,
  });
  assert.deepEqual(body.jobs, { pending: 1 });
  assert.deepEqual(body.tokens, { input: 900, output: 120 });
  assert.equal(body.sessions.length, 1);
  assert.equal(body.sessions[0].external_session_id, "sess-o1");
  assert.equal(body.sessions[0].status, "connected");
  assert.equal(body.status.processing, true);

  // §106: the console is metadata. No message text, no Summary text, and not
  // the member-authored Group name either.
  const raw = JSON.stringify(body);
  assert.equal(raw.includes("kopi money lah"), false);
  assert.equal(raw.includes("deposit paid"), false);
  assert.equal(raw.includes("og1@g.us"), false);

  // §108: operator access is a separate secret, never an Account token.
  assert.equal((await h.op("GET", `/admin/accounts/${userId}`, undefined, "wrong")).status, 401);
  assert.equal((await h.api("o1", "GET", `/admin/accounts/${userId}`)).status, 401);
  assert.equal(
    (await h.op("GET", `/admin/accounts/00000000-0000-0000-0000-000000000000`)).status,
    404,
  );
});

test("an Operator changes an Account's Plan and the caps move with it", async () => {
  const userId = await h.seedUser("o2");

  const up = await h.op("PUT", `/admin/accounts/${userId}/plan`, { plan: "pro" });
  assert.equal(up.status, 200);
  assert.deepEqual(await up.json(), { plan: "pro" });
  let usage = (await h.api("o2", "GET", "/v1/usage")).body as any;
  assert.equal(usage.plan, "pro");
  assert.deepEqual(usage.limits, PLANS.pro);

  const down = await h.op("PUT", `/admin/accounts/${userId}/plan`, { plan: "free" });
  assert.equal(down.status, 200);
  usage = (await h.api("o2", "GET", "/v1/usage")).body as any;
  assert.deepEqual(usage.limits, PLANS.free);

  assert.equal(
    (await h.op("PUT", `/admin/accounts/${userId}/plan`, { plan: "enterprise" })).status,
    400,
  );
  assert.equal(
    (await h.op("PUT", `/admin/accounts/00000000-0000-0000-0000-000000000000/plan`, { plan: "pro" }))
      .status,
    404,
  );
  // The bad Plan never landed.
  const { rows } = await h.pool.query(`SELECT plan FROM users WHERE id = $1`, [userId]);
  assert.equal(rows[0].plan, "free");
});
