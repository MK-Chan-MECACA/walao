import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { buildEvent, countIngestEvents, makeHarness, type Harness } from "./helpers.ts";
import { HANDSHAKE_SUFFIX } from "../src/tier1.ts";

// Ticket 13: Tier 1 opt-in outbound (spec §47) + recipient "Yes" handshake
// (spec §48). Whole-system seam: real ingress + API, sends captured by the
// fake gateway's recipientSends.

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

const BUDDY = "buddy@s.whatsapp.net";

async function seedTier1User(token: string): Promise<string> {
  const userId = await h.seedUser(token);
  await h.seedSession(userId, `sess-${token}`);
  const res = await h.api(token, "POST", "/v1/tier1", { authorization_version: "tier1-v1" });
  assert.equal(res.status, 200);
  return userId;
}

test("outbound requires explicit Tier 1 opt-in, and opt-in requires an authorization version", async () => {
  const userId = await h.seedUser("t0");
  await h.seedSession(userId, "sess-t0");

  const res = await h.api("t0", "POST", "/v1/outbound", { recipient: BUDDY, text: "hi" });
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: "tier1_required" });
  assert.equal(h.gateway.recipientSends.length, 0);

  const bad = await h.api("t0", "POST", "/v1/tier1", {});
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body, { error: "authorization_required" });
});

test("first message to a new number carries the Yes-handshake ask, then further sends block", async () => {
  await seedTier1User("t1");

  const first = await h.api("t1", "POST", "/v1/outbound", {
    recipient: BUDDY,
    text: "meeting moved to 3pm",
  });
  assert.equal(first.status, 201);
  assert.deepEqual(first.body, { sent: true, handshake: "pending" });
  assert.deepEqual(h.gateway.recipientSends, [
    {
      sessionExternalId: "sess-t1",
      recipientJid: BUDDY,
      text: "meeting moved to 3pm" + HANDSHAKE_SUFFIX,
    },
  ]);

  const second = await h.api("t1", "POST", "/v1/outbound", { recipient: BUDDY, text: "also…" });
  assert.equal(second.status, 409);
  assert.deepEqual(second.body, { error: "handshake_pending" });
  assert.equal(h.gateway.recipientSends.length, 1); // nothing else went out
});

test('recipient "Yes" unblocks further outbound; other replies leave it pending', async () => {
  await seedTier1User("t1");
  await h.api("t1", "POST", "/v1/outbound", { recipient: BUDDY, text: "hello" });

  assert.equal(
    await h.postWebhook(
      buildEvent({ session: "sess-t1", id: "r1", chatId: BUDDY, text: "who is this?" }),
    ),
    202,
  );
  let res = await h.api("t1", "POST", "/v1/outbound", { recipient: BUDDY, text: "again" });
  assert.equal(res.status, 409);

  assert.equal(
    await h.postWebhook(buildEvent({ session: "sess-t1", id: "r2", chatId: BUDDY, text: " Yes " })),
    202,
  );
  res = await h.api("t1", "POST", "/v1/outbound", { recipient: BUDDY, text: "great, see you" });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, { sent: true, handshake: "confirmed" });
  // confirmed sends go out verbatim — no handshake suffix
  assert.equal(h.gateway.recipientSends.at(-1)?.text, "great, see you");
});

test("recipient DMs are never stored and never registered as groups", async () => {
  await seedTier1User("t1");
  await h.api("t1", "POST", "/v1/outbound", { recipient: BUDDY, text: "hello" });
  await h.postWebhook(buildEvent({ session: "sess-t1", id: "r1", chatId: BUDDY, text: "yes" }));
  await h.drain();

  const groups = await h.pool.query(`SELECT 1 FROM groups WHERE external_jid = $1`, [BUDDY]);
  assert.equal(groups.rowCount, 0);
  const msgs = await h.pool.query(`SELECT 1 FROM messages`);
  assert.equal(msgs.rowCount, 0);
  assert.equal(await countIngestEvents(h.pool), 0);
});

test("handshake is per user: one recipient's Yes to user A does nothing for user B", async () => {
  await seedTier1User("t1");
  await seedTier1User("t2");
  await h.api("t1", "POST", "/v1/outbound", { recipient: BUDDY, text: "hi from A" });
  await h.postWebhook(buildEvent({ session: "sess-t1", id: "r1", chatId: BUDDY, text: "Yes" }));

  const first = await h.api("t2", "POST", "/v1/outbound", { recipient: BUDDY, text: "hi from B" });
  assert.equal(first.status, 201);
  assert.deepEqual(first.body, { sent: true, handshake: "pending" });
  const second = await h.api("t2", "POST", "/v1/outbound", { recipient: BUDDY, text: "more" });
  assert.equal(second.status, 409);
});

test("paused user cannot send outbound", async () => {
  await seedTier1User("t1");
  await h.api("t1", "POST", "/v1/pause");
  const res = await h.api("t1", "POST", "/v1/outbound", { recipient: BUDDY, text: "hi" });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: "paused" });
  assert.equal(h.gateway.recipientSends.length, 0);
});
