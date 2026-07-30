import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, buildEvent, type Harness } from "./helpers.ts";

// Zero-tolerance invariant (README §16: cross-tenant data leaks = 0).
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

test("a second user can never read the first user's message", async () => {
  const alice = "tok-alice";
  const bob = "tok-bob";
  const aliceId = await h.seedUser(alice);
  const bobId = await h.seedUser(bob);
  const aliceSession = await h.seedSession(aliceId, "sess-alice");
  await h.seedSession(bobId, "sess-bob");
  await h.seedGroup(aliceSession, "group-1@g.us");

  // Alice's message arrives on her session.
  await h.postWebhook(buildEvent({ session: "sess-alice", id: "a1", text: "alice secret" }));
  await h.drain();

  // Alice sees exactly her message.
  const aliceView = await h.getMessages(alice);
  assert.equal(aliceView.messages.length, 1);
  assert.equal((aliceView.messages[0] as { text: string }).text, "alice secret");

  // Bob, with no messages of his own, must see nothing — never Alice's.
  const bobView = await h.getMessages(bob);
  assert.equal(bobView.status, 200);
  assert.equal(bobView.messages.length, 0);
});

test("unauthenticated read is rejected", async () => {
  const res = await fetch(`${h.baseUrl}/v1/messages`);
  assert.equal(res.status, 401);
});
