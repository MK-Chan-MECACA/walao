import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, buildEvent, countIngestEvents, type Harness } from "./helpers.ts";

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

test("valid event becomes an encrypted message visible via the API for its owner", async () => {
  const token = "tok-alice";
  const userId = await h.seedUser(token);
  await h.seedSession(userId, "sess-1");

  assert.equal(await h.postWebhook(buildEvent({ text: "Approved the RM500 order" })), 202);
  assert.equal(await h.drain(), 1);

  const { status, messages } = await h.getMessages(token);
  assert.equal(status, 200);
  assert.equal(messages.length, 1);
  assert.equal((messages[0] as { text: string }).text, "Approved the RM500 order");

  // Stored body must be ciphertext, never plaintext (encrypted at rest).
  const { rows } = await h.pool.query(
    `SELECT body_ciphertext FROM messages WHERE user_id = $1`,
    [userId],
  );
  assert.ok(!rows[0].body_ciphertext.toString("utf8").includes("Approved"));
});

test("forged HMAC is rejected and leaves no trace", async () => {
  const userId = await h.seedUser("tok");
  await h.seedSession(userId, "sess-1");

  assert.equal(await h.postWebhook(buildEvent(), { signature: "deadbeef" }), 401);
  assert.equal(await countIngestEvents(h.pool), 0);
  assert.equal(await h.drain(), 0);
});

test("stale event (outside freshness window) is rejected and leaves no trace", async () => {
  const userId = await h.seedUser("tok");
  await h.seedSession(userId, "sess-1");

  const stale = buildEvent({ sentAt: new Date(Date.now() - 3600_000).toISOString() });
  assert.equal(await h.postWebhook(stale), 400);
  assert.equal(await countIngestEvents(h.pool), 0);
});

test("replayed event (duplicate session+id) is idempotent — no double store", async () => {
  const token = "tok";
  const userId = await h.seedUser(token);
  await h.seedSession(userId, "sess-1");

  const evt = buildEvent({ id: "msg-dup" });
  assert.equal(await h.postWebhook(evt), 202);
  assert.equal(await h.postWebhook(evt), 202); // replay accepted, but deduped
  assert.equal(await countIngestEvents(h.pool), 1);

  await h.drain();
  // Even a replay that arrives after processing must not create a second row.
  assert.equal(await h.postWebhook(evt), 202);
  await h.drain();

  const { messages } = await h.getMessages(token);
  assert.equal(messages.length, 1);
});

test("ingestion survives a consumer restart without losing the event", async () => {
  const token = "tok";
  const userId = await h.seedUser(token);
  await h.seedSession(userId, "sess-1");

  // Enqueue but do NOT drain — simulates the consumer being down.
  assert.equal(await h.postWebhook(buildEvent({ id: "msg-durable" })), 202);
  assert.equal((await h.getMessages(token)).messages.length, 0);

  // The event persisted durably in Postgres; a fresh drain (restart) recovers it.
  assert.equal(await h.drain(), 1);
  assert.equal((await h.getMessages(token)).messages.length, 1);
});
