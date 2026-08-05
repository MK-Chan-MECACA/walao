import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, type Harness } from "./helpers.ts";
import { backfillGroupNames } from "../src/subscriptions.ts";

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

async function nameOf(groupId: string): Promise<string | null> {
  const { rows } = await h.pool.query(`SELECT name FROM groups WHERE id = $1`, [groupId]);
  return rows[0].name;
}

describe("group name backfill", () => {
  it("fills unnamed groups from the gateway without overwriting known names", async () => {
    const userId = await h.seedUser("tok");
    const sessionId = await h.seedSession(userId, "sess-1");
    const unnamed = await h.seedGroup(sessionId, "aaa@g.us");
    const named = await h.seedGroup(sessionId, "bbb@g.us");
    await h.pool.query(`UPDATE groups SET name = 'Set By Hand' WHERE id = $1`, [named]);

    h.gateway.groupNames["sess-1"] = [
      { jid: "aaa@g.us", name: "Real Group" },
      { jid: "bbb@g.us", name: "Gateway Name" },
    ];

    assert.equal(await backfillGroupNames(h.pool, h.gateway), 1);
    assert.equal(await nameOf(unnamed), "Real Group");
    // An existing name is authoritative — the backfill only ever fills NULL.
    assert.equal(await nameOf(named), "Set By Hand");

    // Second pass is a no-op: nothing is left unnamed.
    assert.equal(await backfillGroupNames(h.pool, h.gateway), 0);
  });

  // A jid the gateway does not return can never be named, so it must stop
  // being asked about: an unnamed row left NULL kept this session in the
  // backfill query forever, and WhatsApp answers that with 429 rate-overlimit
  // and closes the stream. One pass, then the session is done.
  it("settles a group the gateway does not know on its jid instead of re-asking", async () => {
    const userId = await h.seedUser("tok");
    const sessionId = await h.seedSession(userId, "sess-1");
    const g = await h.seedGroup(sessionId, "ccc@g.us");
    h.gateway.groupNames["sess-1"] = [{ jid: "other@g.us", name: "Someone Else" }];

    assert.equal(await backfillGroupNames(h.pool, h.gateway), 0);
    assert.equal(await nameOf(g), "ccc@g.us");

    // The pass converged: nothing is unnamed, so the gateway is never called
    // again for this session.
    let calls = 0;
    h.gateway.listGroups = () => {
      calls += 1;
      return Promise.resolve([]);
    };
    assert.equal(await backfillGroupNames(h.pool, h.gateway), 0);
    assert.equal(calls, 0);
  });

  // An empty list is ambiguous — a session still warming up looks exactly like
  // one that left every group. Do not settle on it; wait for a real answer.
  it("does not settle anything when the gateway returns no groups at all", async () => {
    const userId = await h.seedUser("tok");
    const sessionId = await h.seedSession(userId, "sess-1");
    const g = await h.seedGroup(sessionId, "fff@g.us");
    h.gateway.groupNames["sess-1"] = [];

    assert.equal(await backfillGroupNames(h.pool, h.gateway), 0);
    assert.equal(await nameOf(g), null);
  });

  it("does not touch groups on a disconnected session", async () => {
    const userId = await h.seedUser("tok");
    const sessionId = await h.seedSession(userId, "sess-1");
    const g = await h.seedGroup(sessionId, "ddd@g.us");
    await h.pool.query(`UPDATE whatsapp_sessions SET status = 'disconnected' WHERE id = $1`, [
      sessionId,
    ]);
    h.gateway.groupNames["sess-1"] = [{ jid: "ddd@g.us", name: "Real Group" }];

    assert.equal(await backfillGroupNames(h.pool, h.gateway), 0);
    assert.equal(await nameOf(g), null);
  });

  it("a failing gateway is skipped, not fatal", async () => {
    const userId = await h.seedUser("tok");
    const sessionId = await h.seedSession(userId, "sess-1");
    const g = await h.seedGroup(sessionId, "eee@g.us");
    h.gateway.listGroups = () => Promise.reject(new Error("gateway down"));

    assert.equal(await backfillGroupNames(h.pool, h.gateway), 0);
    assert.equal(await nameOf(g), null);
  });
});
