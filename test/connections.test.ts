import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, buildEvent, countIngestEvents, type Harness } from "./helpers.ts";
import { ONBOARDING_DISCLOSURE } from "../src/connections.ts";

// Ticket 3: pair, health, disconnect, incomplete-coverage markers.
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

type Connection = { id: string; external_session_id: string; status: string };

async function connections(token: string): Promise<Connection[]> {
  const res = await h.api(token, "GET", "/v1/connections");
  return (res.body as { connections: Connection[] }).connections;
}

async function gaps(): Promise<{ reason: string; ended_at: string | null }[]> {
  const { rows } = await h.pool.query(
    `SELECT reason, ended_at FROM coverage_gaps ORDER BY started_at`,
  );
  return rows;
}

test("pairing requires the onboarding disclosure and produces a tenant-scoped session", async () => {
  await h.seedUser("tok-a");
  await h.seedUser("tok-b");

  // Disclosure exists and names the risks in plain language.
  const onboarding = await h.api("tok-a", "GET", "/v1/onboarding");
  assert.equal(onboarding.status, 200);
  const disclosure = onboarding.body as { version: string; text: string };
  assert.equal(disclosure.version, ONBOARDING_DISCLOSURE.version);
  for (const topic of ["expire", "AI provider", "gateway", "disconnect"]) {
    assert.match(disclosure.text, new RegExp(topic, "i"));
  }

  // No acknowledgment, no pairing — zero sessions created.
  const refused = await h.api("tok-a", "POST", "/v1/connections", {});
  assert.equal(refused.status, 400);
  assert.equal((await connections("tok-a")).length, 0);

  // Acknowledged pairing completes against the fake gateway.
  const created = await h.api("tok-a", "POST", "/v1/connections", {
    disclosure_version: disclosure.version,
  });
  assert.equal(created.status, 201);
  const body = created.body as { connection: Connection; pairing_code: string };
  assert.ok(body.pairing_code);
  assert.equal(body.connection.status, "pending");

  // Tenant boundary: only the owner sees it.
  assert.equal((await connections("tok-a")).length, 1);
  assert.equal((await connections("tok-b")).length, 0);
});

test("connection health reflects gateway state changes", async () => {
  await h.seedUser("tok");
  const created = await h.api("tok", "POST", "/v1/connections", {
    disclosure_version: ONBOARDING_DISCLOSURE.version,
  });
  const extId = (created.body as { connection: Connection }).connection.external_session_id;

  assert.equal((await connections("tok"))[0].status, "pending");

  assert.equal(await h.postWebhook({ kind: "status", session: extId, status: "connected" }), 202);
  assert.equal((await connections("tok"))[0].status, "connected");

  assert.equal(
    await h.postWebhook({ kind: "status", session: extId, status: "re_pair_required" }),
    202,
  );
  assert.equal((await connections("tok"))[0].status, "re_pair_required");
});

test("pairing fills the Groups list from the gateway, disabled and ready to enable", async () => {
  await h.seedUser("tok");
  const created = await h.api("tok", "POST", "/v1/connections", {
    disclosure_version: ONBOARDING_DISCLOSURE.version,
  });
  const extId = (created.body as { connection: Connection }).connection.external_session_id;
  h.gateway.groupNames[extId] = [
    { jid: "120363000000000001@g.us", name: "LEAD Marketing" },
    { jid: "status@broadcast", name: null }, // not a Group: never listed
  ];

  await h.postWebhook({ kind: "status", session: extId, status: "connected" });

  const { body } = await h.api("tok", "GET", "/v1/groups");
  const groups = (body as { groups: Array<{ external_jid: string; name: string; enabled: boolean }> })
    .groups;
  assert.deepEqual(
    groups.map((g) => [g.external_jid, g.name, g.enabled]),
    [["120363000000000001@g.us", "LEAD Marketing", false]],
  );
});

test("a session ingests nothing until the gateway reports it connected", async () => {
  await h.seedUser("tok");
  const created = await h.api("tok", "POST", "/v1/connections", {
    disclosure_version: ONBOARDING_DISCLOSURE.version,
  });
  const conn = (created.body as { connection: Connection }).connection;
  await h.seedGroup(conn.id, "group-1@g.us");

  // Pending session: dropped at ingress.
  assert.equal(await h.postWebhook(buildEvent({ session: conn.external_session_id })), 202);
  assert.equal(await countIngestEvents(h.pool), 0);

  // Connected: flows end to end.
  await h.postWebhook({ kind: "status", session: conn.external_session_id, status: "connected" });
  await h.postWebhook(buildEvent({ session: conn.external_session_id, id: "msg-2" }));
  assert.equal(await h.drain(), 1);
  assert.equal((await h.getMessages("tok")).messages.length, 1);
});

test("disconnect stops ingestion immediately, including already-queued events", async () => {
  const userId = await h.seedUser("tok");
  const sessionId = await h.seedSession(userId, "sess-1");
  await h.seedGroup(sessionId, "group-1@g.us");

  // Queued while connected, but not yet processed.
  assert.equal(await h.postWebhook(buildEvent()), 202);
  assert.equal(await countIngestEvents(h.pool), 1);

  assert.equal((await h.api("tok", "POST", `/v1/connections/${sessionId}/disconnect`)).status, 200);

  // Queued event is skipped, and new events never enter the queue.
  assert.equal(await h.drain(), 0);
  assert.equal(await h.postWebhook(buildEvent({ id: "msg-2" })), 202);
  assert.equal(await countIngestEvents(h.pool), 1);
  assert.equal((await h.getMessages("tok")).messages.length, 0);
});

test("disconnection opens an incomplete-coverage gap; reconnection closes it", async () => {
  const userId = await h.seedUser("tok");
  const sessionId = await h.seedSession(userId, "sess-1");

  await h.api("tok", "POST", `/v1/connections/${sessionId}/disconnect`);
  let g = await gaps();
  assert.equal(g.length, 1);
  assert.equal(g[0].reason, "disconnected");
  assert.equal(g[0].ended_at, null);

  // A second gateway-side failure while already down must not open a second gap.
  await h.postWebhook({ kind: "status", session: "sess-1", status: "re_pair_required" });
  assert.equal((await gaps()).length, 1);

  await h.postWebhook({ kind: "status", session: "sess-1", status: "connected" });
  g = await gaps();
  assert.equal(g.length, 1);
  assert.notEqual(g[0].ended_at, null);
});

test("cannot disconnect another user's connection", async () => {
  const userId = await h.seedUser("tok-a");
  const sessionId = await h.seedSession(userId, "sess-1");
  await h.seedUser("tok-b");

  const res = await h.api("tok-b", "POST", `/v1/connections/${sessionId}/disconnect`);
  assert.equal(res.status, 404);
  assert.equal((await connections("tok-a"))[0].status, "connected");
  assert.equal((await gaps()).length, 0);
});
