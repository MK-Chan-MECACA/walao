import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildEvent, makeHarness, type Harness } from "./helpers.ts";
import { tickScheduler } from "../src/scheduler.ts";

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

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM (${sql}) q`, params);
  return rows[0].n;
}

// Whole-system trace check: every table that can reference the group, plus a
// content scan of every column that can hold copied/raw text. Postgres is the
// only store — no caches, indexes, or backups exist to check.
async function groupTraces(groupId: string, marker: string): Promise<number> {
  let n = 0;
  for (const sql of [
    `SELECT 1 FROM groups WHERE id = $1`,
    `SELECT 1 FROM messages WHERE group_id = $1`,
    `SELECT 1 FROM summaries WHERE group_id = $1`,
    `SELECT 1 FROM summary_jobs WHERE group_id = $1`,
    `SELECT 1 FROM summary_schedules WHERE group_id = $1`,
    `SELECT 1 FROM attestations WHERE group_id = $1`,
  ]) {
    n += await count(sql, [groupId]);
  }
  for (const sql of [
    `SELECT 1 FROM ingest_events WHERE payload::text LIKE $1`,
    `SELECT 1 FROM summaries WHERE payload::text LIKE $1`,
    `SELECT 1 FROM reminders WHERE text LIKE $1`,
    `SELECT 1 FROM privacy_audit WHERE detail LIKE $1`,
  ]) {
    n += await count(sql, [`%${marker}%`]);
  }
  return n;
}

async function auditActions(userId: string): Promise<string[]> {
  const { rows } = await h.pool.query(
    `SELECT action FROM privacy_audit WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );
  return rows.map((r) => r.action);
}

describe("privacy controls", () => {
  it("pause halts every stage of the pipeline; resume picks back up", async () => {
    const userId = await h.seedUser("tok-a");
    const sessionId = await h.seedSession(userId, "sess-1");
    const groupId = await h.seedGroup(sessionId, "group-1@g.us"); // buildEvent's default chatId

    // Baseline: unpaused, events flow end to end.
    await h.postWebhook(buildEvent({ id: "m1" }));
    assert.equal(await h.drain(), 1);

    // Queued before pause, drained after: dropped, not stored.
    await h.postWebhook(buildEvent({ id: "m2" }));
    assert.equal((await h.api("tok-a", "POST", "/v1/pause")).status, 200);
    assert.equal(await h.drain(), 0);

    // Posted while paused: dropped at ingress, never even queued.
    assert.equal(await h.postWebhook(buildEvent({ id: "m3" })), 202);
    assert.equal(await count(`SELECT 1 FROM ingest_events WHERE status = 'pending'`, []), 0);
    assert.equal(await count(`SELECT 1 FROM messages WHERE user_id = $1`, [userId]), 1);

    // Scheduler emits no jobs for a paused user even with messages waiting.
    await h.api("tok-a", "PUT", `/v1/groups/${groupId}/schedule`, {
      local_time: "00:00",
      timezone: "UTC",
      language: "en",
    });
    assert.deepEqual(await tickScheduler(h.pool), []);

    // A pending job and an undelivered summary both wait while paused.
    await h.pool.query(
      `INSERT INTO summary_jobs (group_id, language, window_start, window_end)
       VALUES ($1, 'en', now() - interval '1 hour', now())`,
      [groupId],
    );
    assert.equal(await h.summarize(), 0);
    await h.seedSummary(userId, groupId, {});
    assert.equal(await h.deliver(), 0);
    assert.equal(h.gateway.sends.length, 0);

    // Resume: ingestion, jobs, and delivery all move again.
    assert.equal((await h.api("tok-a", "POST", "/v1/resume")).status, 200);
    await h.postWebhook(buildEvent({ id: "m4" }));
    assert.equal(await h.drain(), 1);
    assert.equal(await h.summarize(), 1);
    assert.ok((await h.deliver()) >= 1);

    assert.deepEqual(await auditActions(userId), ["pause", "resume"]);
  });

  it("export covers messages, summaries, and settings in portable JSON", async () => {
    const userId = await h.seedUser("tok-a");
    const sessionId = await h.seedSession(userId, "sess-1");
    const groupId = await h.seedGroup(sessionId, "g1@g.us");
    await h.seedMessage(groupId, "m1", new Date().toISOString(), { text: "hello export" });
    await h.seedSummary(userId, groupId, {
      decisions: [{ text: "Ship it", source_message_ids: ["m1"] }],
    });
    await h.api("tok-a", "PUT", `/v1/groups/${groupId}/schedule`, {
      local_time: "09:00",
      timezone: "Asia/Kuala_Lumpur",
      language: "en",
    });

    const res = await h.api("tok-a", "GET", "/v1/export");
    assert.equal(res.status, 200);
    const body = res.body as {
      messages: { text: string }[];
      summaries: { payload: { decisions: { text: string }[] } }[];
      settings: {
        retention_days: number;
        paused: boolean;
        groups: { external_jid: string; enabled: boolean; local_time: string | null }[];
      };
    };
    assert.deepEqual(body.messages.map((m) => m.text), ["hello export"]);
    assert.deepEqual(body.summaries[0].payload.decisions.map((d) => d.text), ["Ship it"]);
    assert.equal(body.settings.retention_days, 7);
    assert.equal(body.settings.paused, false);
    assert.deepEqual(body.settings.groups, [
      {
        external_jid: "g1@g.us",
        name: null,
        enabled: true,
        local_time: "09:00",
        timezone: "Asia/Kuala_Lumpur",
        language: "en",
      },
    ]);
    assert.deepEqual(await auditActions(userId), ["export"]);
  });

  it("group delete removes messages, summaries, derived data, and queued raw payloads — siblings intact", async () => {
    const MARKER = "zebra-invoice-9911";
    const userId = await h.seedUser("tok-a");
    const sessionId = await h.seedSession(userId, "sess-1");
    const gA = await h.seedGroup(sessionId, "ga@g.us");
    const gB = await h.seedGroup(sessionId, "gb@g.us");

    await h.seedMessage(gA, "a1", new Date().toISOString(), { text: MARKER });
    await h.seedMessage(gB, "b1", new Date().toISOString(), { text: "keep me" });
    const sidA = await h.seedSummary(userId, gA, {
      action_items: [
        { text: MARKER, source_message_ids: ["a1"], owner: null, due_at: null, confidence: 1 },
      ],
    });
    const sidB = await h.seedSummary(userId, gB, {
      highlights: [{ text: "b-side", source_message_ids: ["b1"] }],
    });
    // Derived data: item state + confirmed reminder copied from A's summary.
    await h.api("tok-a", "PUT", `/v1/summaries/${sidA}/items/action_items/0/state`, {
      state: "complete",
    });
    await h.api("tok-a", "POST", `/v1/summaries/${sidA}/action-items/0/confirm`);
    // Queued-but-undrained raw payload for A: the webhook JSON holds the text.
    await h.postWebhook(buildEvent({ id: "a2", chatId: "ga@g.us", text: MARKER }));

    // Cross-tenant delete looks like not-found.
    await h.seedUser("tok-b");
    assert.equal((await h.api("tok-b", "DELETE", `/v1/groups/${gA}`)).status, 404);

    assert.equal((await h.api("tok-a", "DELETE", `/v1/groups/${gA}`)).status, 200);

    // Whole-system: zero trace of the group or its content anywhere.
    assert.equal(await groupTraces(gA, MARKER), 0);
    assert.equal(await count(`SELECT 1 FROM item_states WHERE summary_id = $1`, [sidA]), 0);
    assert.equal(await count(`SELECT 1 FROM reminders WHERE user_id = $1`, [userId]), 0);
    // Sibling group untouched.
    assert.equal(await count(`SELECT 1 FROM messages WHERE group_id = $1`, [gB]), 1);
    assert.equal(await count(`SELECT 1 FROM summaries WHERE group_id = $1`, [gB]), 1);

    const { rows } = await h.pool.query(
      `SELECT action, detail FROM privacy_audit WHERE user_id = $1`,
      [userId],
    );
    assert.deepEqual(rows, [{ action: "delete_group", detail: "ga@g.us" }]);
  });

  it("account delete removes everything; only a content-free audit event remains", async () => {
    const MARKER = "quokka-payroll-7733";
    const userId = await h.seedUser("tok-a");
    const sessionId = await h.seedSession(userId, "sess-1");
    const groupId = await h.seedGroup(sessionId, "g1@g.us");
    await h.seedMessage(groupId, "m1", new Date().toISOString(), { text: MARKER });
    const sid = await h.seedSummary(userId, groupId, {
      action_items: [
        { text: MARKER, source_message_ids: ["m1"], owner: null, due_at: null, confidence: 1 },
      ],
    });
    await h.api("tok-a", "POST", `/v1/summaries/${sid}/action-items/0/confirm`);
    await h.postWebhook(buildEvent({ id: "m2", chatId: "g1@g.us", text: MARKER })); // queued raw payload
    // Another tenant that must survive untouched.
    const otherId = await h.seedUser("tok-b");
    const otherSess = await h.seedSession(otherId, "sess-o");
    const og = await h.seedGroup(otherSess, "go@g.us");
    await h.seedMessage(og, "o1", new Date().toISOString(), { text: "other tenant" });

    assert.equal((await h.api("tok-a", "DELETE", "/v1/account")).status, 200);

    // Whole-system: no row anywhere belongs to the user, no content trace.
    for (const sql of [
      `SELECT 1 FROM users WHERE id = $1`,
      `SELECT 1 FROM whatsapp_sessions WHERE user_id = $1`,
      `SELECT 1 FROM messages WHERE user_id = $1`,
      `SELECT 1 FROM summaries WHERE user_id = $1`,
      `SELECT 1 FROM reminders WHERE user_id = $1`,
      `SELECT 1 FROM item_states WHERE user_id = $1`,
      `SELECT 1 FROM attestations WHERE user_id = $1`,
    ]) {
      assert.equal(await count(sql, [userId]), 0, sql);
    }
    assert.equal(await count(`SELECT 1 FROM groups WHERE session_id = $1`, [sessionId]), 0);
    assert.equal(
      await count(`SELECT 1 FROM ingest_events WHERE session_external_id = 'sess-1'`, []),
      0,
    );
    for (const sql of [
      `SELECT 1 FROM ingest_events WHERE payload::text LIKE $1`,
      `SELECT 1 FROM privacy_audit WHERE coalesce(detail, '') LIKE $1`,
    ]) {
      assert.equal(await count(sql, [`%${MARKER}%`]), 0, sql);
    }
    // The token no longer authenticates.
    assert.equal((await h.api("tok-a", "GET", "/v1/export")).status, 401);
    // Other tenant intact.
    assert.equal(await count(`SELECT 1 FROM messages WHERE user_id = $1`, [otherId]), 1);
    // The provable, content-free record of the deletion outlives the account.
    assert.deepEqual(await auditActions(userId), ["delete_account"]);
  });
});
