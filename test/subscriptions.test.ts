import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, buildEvent, countIngestEvents, type Harness } from "./helpers.ts";
import { ATTESTATION_VERSION } from "../src/subscriptions.ts";

// Ticket 2 zero-tolerance invariant: unauthorized groups processed = 0.
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

type Group = { id: string; external_jid: string; enabled: boolean };

async function groups(token: string): Promise<Group[]> {
  const res = await h.api(token, "GET", "/v1/groups");
  return (res.body as { groups: Group[] }).groups;
}

test("message for an unseen group is dropped at the boundary; group becomes listable, disabled", async () => {
  const token = "tok";
  const userId = await h.seedUser(token);
  await h.seedSession(userId, "sess-1");

  assert.equal(await h.postWebhook(buildEvent({ text: "secret before consent" })), 202);

  // Dropped before processing: nothing in the queue, nothing stored.
  assert.equal(await countIngestEvents(h.pool), 0);
  assert.equal(await h.drain(), 0);
  assert.equal((await h.getMessages(token)).messages.length, 0);

  // But the group is now discoverable — disabled by default.
  const list = await groups(token);
  assert.equal(list.length, 1);
  assert.equal(list[0].external_jid, "group-1@g.us");
  assert.equal(list[0].enabled, false);
});

test("enable requires the current attestation version", async () => {
  const token = "tok";
  const userId = await h.seedUser(token);
  const sessionId = await h.seedSession(userId, "sess-1");
  const groupId = await h.seedGroup(sessionId, "group-1@g.us", false);

  const missing = await h.api(token, "POST", `/v1/groups/${groupId}/enable`, {});
  assert.equal(missing.status, 400);
  const stale = await h.api(token, "POST", `/v1/groups/${groupId}/enable`, {
    attestation_version: "1999-01-01",
  });
  assert.equal(stale.status, 400);
  assert.equal((await groups(token))[0].enabled, false);
});

test("enabling records a consent attestation (version + timestamp) and lets messages flow", async () => {
  const token = "tok";
  const userId = await h.seedUser(token);
  const sessionId = await h.seedSession(userId, "sess-1");
  const groupId = await h.seedGroup(sessionId, "group-1@g.us", false);

  const res = await h.api(token, "POST", `/v1/groups/${groupId}/enable`, {
    attestation_version: ATTESTATION_VERSION,
  });
  assert.equal(res.status, 200);
  assert.equal((await groups(token))[0].enabled, true);

  // Audit trail is queryable.
  const audit = await h.api(token, "GET", "/v1/attestations");
  const records = (audit.body as { attestations: Array<Record<string, unknown>> }).attestations;
  assert.equal(records.length, 1);
  assert.equal(records[0].group_id, groupId);
  assert.equal(records[0].kind, "group_responsibility");
  assert.equal(records[0].version, ATTESTATION_VERSION);
  assert.ok(!Number.isNaN(Date.parse(records[0].created_at as string)));

  // Messages now flow end to end.
  assert.equal(await h.postWebhook(buildEvent()), 202);
  assert.equal(await h.drain(), 1);
  assert.equal((await h.getMessages(token)).messages.length, 1);
});

test("disabling immediately stops storage — including events already queued", async () => {
  const token = "tok";
  const userId = await h.seedUser(token);
  const sessionId = await h.seedSession(userId, "sess-1");
  const groupId = await h.seedGroup(sessionId, "group-1@g.us", true);

  assert.equal(await h.postWebhook(buildEvent({ id: "m1" })), 202);
  assert.equal(await h.drain(), 1);

  // Race window: m2 is accepted while enabled, but the user disables before
  // the consumer drains it. The store-time guard must skip it.
  assert.equal(await h.postWebhook(buildEvent({ id: "m2" })), 202);
  assert.equal((await h.api(token, "POST", `/v1/groups/${groupId}/disable`)).status, 200);
  assert.equal(await h.drain(), 0);

  // And new events after disable never even reach the queue.
  assert.equal(await h.postWebhook(buildEvent({ id: "m3" })), 202);
  assert.equal(await countIngestEvents(h.pool), 2); // m1 + m2 only; m3 dropped at boundary
  assert.equal((await h.getMessages(token)).messages.length, 1);

  // Disable is audited too.
  const audit = await h.api(token, "GET", "/v1/attestations");
  const records = (audit.body as { attestations: Array<{ kind: string }> }).attestations;
  assert.deepEqual(records.map((r) => r.kind), ["group_disabled"]);
});

test("a user cannot enable another user's group", async () => {
  const aliceId = await h.seedUser("tok-alice");
  await h.seedUser("tok-bob");
  const aliceSession = await h.seedSession(aliceId, "sess-alice");
  const aliceGroup = await h.seedGroup(aliceSession, "group-1@g.us", false);

  const res = await h.api("tok-bob", "POST", `/v1/groups/${aliceGroup}/enable`, {
    attestation_version: ATTESTATION_VERSION,
  });
  assert.equal(res.status, 404);
  assert.equal((await groups("tok-alice"))[0].enabled, false);
  assert.equal((await groups("tok-bob")).length, 0);
});

test("disclosure template is retrievable", async () => {
  const token = "tok";
  await h.seedUser(token);

  const res = await h.api(token, "GET", "/v1/disclosure-template");
  assert.equal(res.status, 200);
  const body = res.body as { version: string; text: string };
  assert.ok(body.version.length > 0);
  assert.ok(body.text.includes("WALAO"));
});
