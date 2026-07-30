import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { buildEvent, makeHarness, type Harness } from "./helpers.ts";
import { tickScheduler } from "../src/scheduler.ts";

// Ticket 7: note-to-self delivery (Tier 0). Summaries go out through the
// gateway port to the user's own chat only; from_me echoes never loop back
// into the pipeline; coverage gaps surface as a visible incomplete warning.
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

async function seedDeliverableSummary(): Promise<{ sessionId: string; groupId: string }> {
  const userId = await h.seedUser("tok");
  const sessionId = await h.seedSession(userId, "sess-1");
  const groupId = await h.seedGroup(sessionId, "group-1@g.us");
  const res = await h.api("tok", "PUT", `/v1/groups/${groupId}/schedule`, {
    local_time: "09:00",
    timezone: "Asia/Kuala_Lumpur",
    language: "en",
  });
  assert.equal(res.status, 200);
  const m1 = await h.seedMessage(groupId, "m1", "2026-07-30T00:30:00Z", {
    text: "Approved the RM500 order",
  });
  assert.equal((await tickScheduler(h.pool, T("2026-07-30T01:00:00Z"))).length, 1);
  h.summarizer.canned = {
    highlights: [{ text: "RM500 order approved", source_message_ids: [m1] }],
  };
  assert.equal(await h.summarize(), 1);
  return { sessionId, groupId };
}

test("summary is delivered once, to the user's own chat, via the gateway", async () => {
  await seedDeliverableSummary();

  assert.equal(await h.deliver(), 1);
  assert.equal(h.gateway.sends.length, 1);
  const send = h.gateway.sends[0];
  assert.equal(send.sessionExternalId, "sess-1");
  assert.ok(send.text.includes("RM500 order approved"));
  assert.ok(!send.text.includes("Incomplete")); // no gap → no warning

  // Next tick: nothing left, no duplicate send.
  assert.equal(await h.deliver(), 0);
  assert.equal(h.gateway.sends.length, 1);
});

test("from_me echo of the delivered summary is not ingested or summarized", async () => {
  const { groupId } = await seedDeliverableSummary();
  assert.equal(await h.deliver(), 1);
  const echoText = h.gateway.sends[0].text;

  // The delivered brief echoes back from the gateway as a from_me event.
  const status = await h.postWebhook(
    buildEvent({ id: "echo-1", fromMe: true, text: echoText, sentAt: new Date().toISOString() }),
  );
  assert.equal(status, 202);
  assert.equal(await h.drain(), 0); // dropped at ingress, nothing queued
  const { rows } = await h.pool.query(`SELECT 1 FROM messages WHERE external_id = 'echo-1'`);
  assert.equal(rows.length, 0);

  // A follow-up window over the echo's timestamp summarizes nothing.
  await h.pool.query(
    `INSERT INTO summary_jobs (group_id, language, window_start, window_end)
     VALUES ($1, 'en', now() - interval '1 hour', now() + interval '1 minute')`,
    [groupId],
  );
  const callsBefore = h.summarizer.calls.length;
  assert.equal(await h.summarize(), 1);
  assert.equal(h.summarizer.calls.length, callsBefore); // empty batch: model never consulted
  assert.ok(h.summarizer.calls.every((c) => c.messages.every((m) => m.text !== echoText)));
});

test("window overlapping a coverage gap is delivered with a visible incomplete flag", async () => {
  const { sessionId } = await seedDeliverableSummary();
  // Gap inside the summarized window (session reconnected since, so delivery runs).
  await h.pool.query(
    `INSERT INTO coverage_gaps (session_id, reason, started_at, ended_at)
     VALUES ($1, 'disconnected', '2026-07-30T00:40:00Z', '2026-07-30T00:50:00Z')`,
    [sessionId],
  );

  assert.equal(await h.deliver(), 1);
  assert.ok(h.gateway.sends[0].text.includes("Incomplete"));
});

test("Tier 0 boundary: sends target only the user's own session, never a group JID", async () => {
  const { sessionId } = await seedDeliverableSummary();
  assert.equal(await h.deliver(), 1);

  assert.ok(h.gateway.sends.length > 0);
  for (const send of h.gateway.sends) {
    assert.equal(send.sessionExternalId, "sess-1");
    // The port carries no recipient at all — a group JID is inexpressible.
    assert.deepEqual(Object.keys(send).sort(), ["sessionExternalId", "text"]);
    assert.ok(!send.sessionExternalId.endsWith("@g.us"));
  }

  // A disconnected session gets no outbound sends at all.
  await h.reset();
  const again = await seedDeliverableSummary();
  await h.pool.query(`UPDATE whatsapp_sessions SET status = 'disconnected' WHERE id = $1`, [
    again.sessionId,
  ]);
  assert.equal(await h.deliver(), 0);
  assert.equal(h.gateway.sends.length, 0);
});
