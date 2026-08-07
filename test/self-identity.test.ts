import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, type Harness } from "./helpers.ts";
import { selfIdentity } from "../src/connections.ts";

// Ticket 02 (migration 030): WALAO learns who the Account holder is on WhatsApp
// when a Session connects. Nothing is user-visible — this exists so mention
// matching has a fact to work from rather than a guess.
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

async function connect(token: string, extId: string): Promise<string> {
  const userId = await h.seedUser(token);
  await h.seedSession(userId, extId);
  assert.equal(await h.postWebhook({ kind: "status", session: extId, status: "connected" }), 202);
  return userId;
}

test("connecting stores both addressing forms and the display name", async () => {
  h.gateway.identities["sess-id1"] = { phone: "60111111111", lid: "40102864666870", name: "MK" };
  const userId = await connect("tok-id1", "sess-id1");

  assert.deepEqual(await selfIdentity(h.pool, userId), {
    phone: "60111111111",
    lid: "40102864666870",
    name: "MK",
  });
});

test("a gateway that cannot name the session leaves the identity empty and still connects", async () => {
  const userId = await connect("tok-id2", "sess-id2");

  const { rows } = await h.pool.query(
    `SELECT status, self_phone, self_lid, self_name FROM whatsapp_sessions WHERE user_id = $1`,
    [userId],
  );
  assert.equal(rows[0].status, "connected");
  assert.deepEqual([rows[0].self_phone, rows[0].self_lid, rows[0].self_name], [null, null, null]);
  assert.equal(await selfIdentity(h.pool, userId), null);
});

test("an unreachable gateway does not fail the connect", async () => {
  h.gateway.identityFails = true;
  try {
    const userId = await connect("tok-id3", "sess-id3");
    const status = (await h.api("tok-id3", "GET", "/v1/status")).body as {
      session: { status: string };
    };
    assert.equal(status.session.status, "connected");
    assert.equal(await selfIdentity(h.pool, userId), null);
  } finally {
    h.gateway.identityFails = false;
  }
});

test("a later connect fills in what the gateway could not name before, and never erases it", async () => {
  const userId = await connect("tok-id4", "sess-id4");
  assert.equal(await selfIdentity(h.pool, userId), null);

  h.gateway.identities["sess-id4"] = { phone: "60122222222", name: "MK Chan" };
  await h.postWebhook({ kind: "status", session: "sess-id4", status: "connected" });
  assert.deepEqual(await selfIdentity(h.pool, userId), {
    phone: "60122222222",
    lid: null,
    name: "MK Chan",
  });

  // A blank answer on a reconnect is a gateway hiccup, not a change of person.
  h.gateway.identities["sess-id4"] = {};
  await h.postWebhook({ kind: "status", session: "sess-id4", status: "connected" });
  assert.deepEqual(await selfIdentity(h.pool, userId), {
    phone: "60122222222",
    lid: null,
    name: "MK Chan",
  });
});

test("identity resolves per Account, newest identified Session first", async () => {
  h.gateway.identities["sess-old"] = { phone: "60133333333", name: "Old" };
  const userId = await connect("tok-id5", "sess-old");

  // Re-pairing leaves the retired row behind; an unidentified newer Session must
  // not shadow the identity that is still known.
  await h.seedSession(userId, "sess-new");
  await h.postWebhook({ kind: "status", session: "sess-new", status: "connected" });
  assert.deepEqual(await selfIdentity(h.pool, userId), {
    phone: "60133333333",
    lid: null,
    name: "Old",
  });

  h.gateway.identities["sess-new"] = { phone: "60144444444", name: "New" };
  await h.postWebhook({ kind: "status", session: "sess-new", status: "connected" });
  assert.deepEqual(await selfIdentity(h.pool, userId), {
    phone: "60144444444",
    lid: null,
    name: "New",
  });
});
