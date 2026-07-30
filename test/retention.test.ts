import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, buildEvent, type Harness } from "./helpers.ts";
import { purgeExpired } from "../src/retention.ts";

// Ticket 4: raw retention & expiry. The controlled clock is the injectable
// `now` of purgeExpired; storage state is only ever observed through the API.
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

const DAY = 86_400_000;
const daysFromNow = (n: number) => new Date(Date.now() + n * DAY);

async function seedTenant(token: string): Promise<void> {
  const userId = await h.seedUser(token);
  const sessionId = await h.seedSession(userId, "sess-1");
  await h.seedGroup(sessionId, "group-1@g.us");
}

test("retention defaults to 7, clamps to 1-30, rejects non-numbers", async () => {
  const token = "tok";
  await h.seedUser(token);

  assert.deepEqual((await h.api(token, "GET", "/v1/retention")).body, { retention_days: 7 });
  assert.deepEqual((await h.api(token, "PUT", "/v1/retention", { retention_days: 0 })).body, {
    retention_days: 1,
  });
  assert.deepEqual((await h.api(token, "PUT", "/v1/retention", { retention_days: 99 })).body, {
    retention_days: 30,
  });
  assert.deepEqual((await h.api(token, "PUT", "/v1/retention", { retention_days: 14 })).body, {
    retention_days: 14,
  });
  assert.equal(
    (await h.api(token, "PUT", "/v1/retention", { retention_days: "soon" })).status,
    400,
  );
  assert.deepEqual((await h.api(token, "GET", "/v1/retention")).body, { retention_days: 14 });
});

test("advancing the clock past expiry removes the raw message from storage", async () => {
  const token = "tok";
  await seedTenant(token);
  await h.postWebhook(buildEvent());
  await h.drain();
  assert.equal((await h.getMessages(token)).messages.length, 1);

  // Day 6: inside the default 7-day window — untouched.
  assert.equal(await purgeExpired(h.pool, daysFromNow(6)), 0);
  assert.equal((await h.getMessages(token)).messages.length, 1);

  // Day 8: past expiry — gone.
  assert.equal(await purgeExpired(h.pool, daysFromNow(8)), 1);
  assert.equal((await h.getMessages(token)).messages.length, 0);
});

test("changing retention applies to new messages; existing keep their stored window", async () => {
  const token = "tok";
  await seedTenant(token);
  await h.postWebhook(buildEvent({ id: "msg-old" }));
  await h.drain();

  await h.api(token, "PUT", "/v1/retention", { retention_days: 1 });
  await h.postWebhook(buildEvent({ id: "msg-new" }));
  await h.drain();

  // Day 2: the 1-day message is gone, the message stored under 7 days remains.
  assert.equal(await purgeExpired(h.pool, daysFromNow(2)), 1);
  const left = (await h.getMessages(token)).messages as { external_id: string }[];
  assert.deepEqual(
    left.map((m) => m.external_id),
    ["msg-old"],
  );
});

test("non-user group members' messages are equally bounded by the window", async () => {
  const token = "tok";
  await seedTenant(token);
  await h.postWebhook(buildEvent({ id: "m1", from: "alice@s.whatsapp.net" }));
  await h.postWebhook(buildEvent({ id: "m2", from: "not-a-walao-user@s.whatsapp.net" }));
  await h.drain();
  assert.equal((await h.getMessages(token)).messages.length, 2);

  assert.equal(await purgeExpired(h.pool, daysFromNow(8)), 2);
  assert.equal((await h.getMessages(token)).messages.length, 0);
});
