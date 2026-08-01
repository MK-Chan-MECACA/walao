import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { buildEvent, makeHarness, type Harness } from "./helpers.ts";
import { PLANS } from "../src/billing.ts";
import { encrypt } from "../src/crypto.ts";

// Ticket 17 (spec §27-31, §212-218): one Processing Block, one reason, honoured
// by every stage. Whole-system seam — real ingress, API, drains and delivery.

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

type Status = {
  processing: boolean;
  block: { reason: string } | null;
  session: { status: string } | null;
  coverage_gap: { reason: string } | null;
};

const status = async (token: string): Promise<Status> =>
  (await h.api(token, "GET", "/v1/status")).body as Status;

test("status reports each reason, most-external cause first", async () => {
  const userId = await h.seedUser("b1");
  const sessionId = await h.seedSession(userId, "sess-b1");

  const healthy = await status("b1");
  assert.equal(healthy.processing, true);
  assert.equal(healthy.block, null);
  assert.equal(healthy.session?.status, "connected");
  assert.equal(healthy.coverage_gap, null);

  const set = (sql: string, params: unknown[] = [userId]) => h.pool.query(sql, params);

  await set(`UPDATE whatsapp_sessions SET status = 'disconnected' WHERE id = $1`, [sessionId]);
  assert.equal((await status("b1")).block?.reason, "disconnected");

  await set(`UPDATE users SET paused = true WHERE id = $1`);
  assert.equal((await status("b1")).block?.reason, "paused"); // outranks disconnected

  await set(`UPDATE users SET unpaid = true WHERE id = $1`);
  assert.equal((await status("b1")).block?.reason, "unpaid"); // outranks paused

  await h.op("POST", "/admin/halt");
  assert.equal((await status("b1")).block?.reason, "halted"); // outranks everything

  await h.op("POST", "/admin/resume");
  await set(`UPDATE users SET paused = false, unpaid = false WHERE id = $1`);
  await set(`UPDATE whatsapp_sessions SET status = 'connected' WHERE id = $1`, [sessionId]);
  const clear = await status("b1");
  assert.equal(clear.processing, true);
  assert.equal(clear.block, null);
});

test("an account with no session reads unpaired, not disconnected", async () => {
  await h.seedUser("b2");
  const s = await status("b2");
  assert.deepEqual(s.block, { reason: "unpaired" });
  assert.equal(s.session, null);
});

test("unpaid blocks ingestion, summaries and delivery alike, and shows why", async () => {
  const userId = await h.seedUser("b3");
  const sessionId = await h.seedSession(userId, "sess-b3");
  const groupId = await h.seedGroup(sessionId, "group-1@g.us"); // buildEvent's default chatId
  await h.pool.query(`UPDATE users SET unpaid = true WHERE id = $1`, [userId]);

  assert.equal(await h.postWebhook(buildEvent({ session: "sess-b3", id: "m1" })), 202);
  assert.equal(await h.drain(), 0); // never queued, never stored

  await h.pool.query(
    `INSERT INTO summary_jobs (group_id, language, window_start, window_end)
     VALUES ($1, 'en', now() - interval '1 hour', now())`,
    [groupId],
  );
  await h.seedSummary(userId, groupId, {});
  assert.equal(await h.summarize(), 0);
  assert.equal(await h.deliver(), 0);
  assert.equal(h.gateway.sends.length, 0);

  const res = await h.api("b3", "POST", "/v1/outbound", { recipient: "60123@c.us", text: "hi" });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: "unpaid" });

  // Clearing it resumes every stage; the job's window is still pending.
  await h.pool.query(`UPDATE users SET unpaid = false WHERE id = $1`, [userId]);
  assert.equal(await h.deliver(), 1);
});

test("pause opens a coverage gap and resume closes it", async () => {
  const userId = await h.seedUser("b4");
  const sessionId = await h.seedSession(userId, "sess-b4");

  assert.equal((await h.api("b4", "POST", "/v1/pause")).status, 200);
  const paused = await status("b4");
  assert.deepEqual(paused.block, { reason: "paused" });
  assert.equal(paused.coverage_gap?.reason, "paused");

  assert.equal((await h.api("b4", "POST", "/v1/resume")).status, 200);
  assert.equal((await status("b4")).coverage_gap, null);
  const { rows } = await h.pool.query(
    `SELECT reason, ended_at IS NOT NULL AS closed FROM coverage_gaps WHERE session_id = $1`,
    [sessionId],
  );
  assert.deepEqual(rows, [{ reason: "paused", closed: true }]);
});

test("a daily cap stops the stage that spends it, not the ones that don't", async () => {
  const userId = await h.seedUser("b5");
  const sessionId = await h.seedSession(userId, "sess-b5");
  const groupId = await h.seedGroup(sessionId, "group-1@g.us");
  await h.pool.query(
    `INSERT INTO messages
       (user_id, session_id, group_id, external_id, sent_at, from_me, body_ciphertext, expires_at)
     SELECT $1, $2, $3, 'bulk-' || i, now(), false, $4, now() + interval '7 days'
     FROM generate_series(1, $5::int) i`,
    [userId, sessionId, groupId, encrypt("x", h.config.encKey), PLANS.free.max_messages_per_day],
  );

  assert.deepEqual((await status("b5")).block, { reason: "over_daily_messages" });
  assert.equal(await h.postWebhook(buildEvent({ session: "sess-b5", id: "over" })), 202);
  assert.equal(await h.drain(), 0);

  // Delivery is not what spends the message cap: an already-made summary still
  // reaches the user.
  await h.seedSummary(userId, groupId, {});
  assert.equal(await h.deliver(), 1);
});

test("a blocked account cannot wedge the summary and delivery drains", async () => {
  const blockedId = await h.seedUser("b6");
  const blockedSession = await h.seedSession(blockedId, "sess-b6");
  const blockedGroup = await h.seedGroup(blockedSession, "g-blocked@g.us");
  await h.pool.query(`UPDATE users SET paused = true WHERE id = $1`, [blockedId]);
  await h.pool.query(
    `INSERT INTO summary_jobs (group_id, language, window_start, window_end)
     VALUES ($1, 'en', now() - interval '1 hour', now())`,
    [blockedGroup],
  );
  await h.seedSummary(blockedId, blockedGroup, {});

  const okId = await h.seedUser("b7");
  const okSession = await h.seedSession(okId, "sess-b7");
  const okGroup = await h.seedGroup(okSession, "g-ok@g.us");
  await h.seedMessage(okGroup, "m1", new Date().toISOString(), { text: "hello" });
  await h.pool.query(
    `INSERT INTO summary_jobs (group_id, language, window_start, window_end)
     VALUES ($1, 'en', now() - interval '1 hour', now() + interval '1 hour')`,
    [okGroup],
  );

  // The blocked account's job and summary are skipped; the healthy one behind
  // them in the queue still gets through.
  assert.equal(await h.summarize(), 1);
  assert.ok((await h.deliver()) >= 1);
  const jobs = await h.pool.query(
    `SELECT status FROM summary_jobs WHERE group_id = $1`,
    [blockedGroup],
  );
  assert.deepEqual(jobs.rows, [{ status: "pending" }]); // still waiting, not failed
});
