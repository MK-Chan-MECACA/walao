import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { buildEvent, makeHarness, type Harness } from "./helpers.ts";
import { PLANS } from "../src/billing.ts";
import { ATTESTATION_VERSION } from "../src/subscriptions.ts";

// Ticket 26: Cancellation (spec §100-104, §236-241). Whole-system seam: going
// back to Free is a plan change and nothing else — no row is deleted, no Group
// is disabled, and the Groups past Free's cap are blocked by the same
// Processing Block every other cap already uses.
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

test("cancellation returns the Account to Free and deletes nothing", async () => {
  const userId = await h.seedUser("c1");
  const sessionId = await h.seedSession(userId, "sess-c1");
  const groupId = await h.seedGroup(sessionId, "cg0@g.us");
  for (let i = 1; i < 4; i++) await h.seedGroup(sessionId, `cg${i}@g.us`);
  await h.pool.query(`UPDATE users SET plan = 'pro' WHERE id = $1`, [userId]);

  const summaryId = await h.seedSummary(userId, groupId, {
    action_items: [{ text: "Pay the deposit", owner: null, due_at: null, confidence: 0.9, source_message_ids: [] }],
    memory_candidates: [{ text: "Supplier is Ah Seng Hardware", source_message_ids: [] }],
  });
  assert.equal(
    (await h.api("c1", "POST", `/v1/summaries/${summaryId}/action-items/0/confirm`, {})).status,
    201,
  );
  assert.equal(
    (await h.api("c1", "POST", `/v1/summaries/${summaryId}/memory-candidates/0/confirm`)).status,
    201,
  );

  const cancel = await h.api("c1", "POST", "/v1/plan/cancel");
  assert.equal(cancel.status, 200);
  assert.deepEqual(cancel.body, { plan: "free" });

  const usage = (await h.api("c1", "GET", "/v1/usage")).body as any;
  assert.equal(usage.plan, "free");
  assert.deepEqual(usage.limits, PLANS.free);
  assert.equal(usage.usage.enabled_groups, 4); // over the cap, still enabled

  // Everything the Account made survives.
  assert.equal(((await h.api("c1", "GET", "/v1/summaries")).body as any).summaries.length, 1);
  assert.equal(((await h.api("c1", "GET", "/v1/reminders")).body as any).reminders.length, 1);
  assert.equal(((await h.api("c1", "GET", "/v1/memories")).body as any).memories.length, 1);
  const groups = ((await h.api("c1", "GET", "/v1/groups")).body as any).groups;
  assert.equal(groups.filter((g: any) => g.enabled).length, 4);
});

test("after cancelling, the longest-enabled Groups keep running and the rest are blocked", async () => {
  const userId = await h.seedUser("c2");
  const sessionId = await h.seedSession(userId, "sess-c2");
  await h.pool.query(`UPDATE users SET plan = 'pro' WHERE id = $1`, [userId]);

  // Enabled through the API in order, so enabled_at — the "N enabled longest"
  // tiebreak the cap ranks on (spec §240) — is real rather than seeded.
  const jids = ["group-1@g.us", "cc1@g.us", "cc2@g.us", "cc-newest@g.us"]; // first is buildEvent's default chat
  const ids: string[] = [];
  for (const jid of jids) {
    const id = await h.seedGroup(sessionId, jid, false);
    const r = await h.api("c2", "POST", `/v1/groups/${id}/enable`, {
      attestation_version: ATTESTATION_VERSION,
    });
    assert.equal(r.status, 200);
    ids.push(id);
  }
  const oldest = ids[0];
  assert.equal((await h.api("c2", "POST", "/v1/plan/cancel")).status, 200);

  const send = (chatId: string, id: string) =>
    h.postWebhook(buildEvent({ session: "sess-c2", id, chatId }));

  assert.equal(await send("cc-newest@g.us", "m-newest"), 202);
  assert.equal(await h.drain(), 0); // over_group_cap: nothing stored

  assert.equal(await send("group-1@g.us", "m-oldest"), 202);
  assert.equal(await h.drain(), 1);
  const { rows } = await h.pool.query(`SELECT group_id FROM messages WHERE user_id = $1`, [userId]);
  assert.deepEqual(rows, [{ group_id: oldest }]);
});
