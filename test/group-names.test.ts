import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, type Harness } from "./helpers.ts";
import { backfillGroupNames, listGroups, seedGroups } from "../src/subscriptions.ts";

let h: Harness;

before(async () => {
  h = await makeHarness();
});
after(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.reset();
  // Several tests stub listGroups to count calls or force a failure. That
  // assignment shadows the class method on the shared fake for every test
  // after it, so drop the own property and let the prototype answer again.
  delete (h.gateway as Partial<Record<"listGroups", unknown>>).listGroups;
  h.gateway.groupNames = {};
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

  // A Community's announcement group and the Group it announces to carry the
  // same name. The member count is the only thing that separates them, so it
  // is a live fact: unlike the name, every listing refreshes it.
  it("keeps the member count current so two same-named Groups stay tellable apart", async () => {
    const userId = await h.seedUser("tok");
    const sessionId = await h.seedSession(userId, "sess-1");
    const announce = await h.seedGroup(sessionId, "ann@g.us");
    const real = await h.seedGroup(sessionId, "real@g.us");
    h.gateway.groupNames["sess-1"] = [
      { jid: "ann@g.us", name: "LEAD Community", members: 5 },
      { jid: "real@g.us", name: "LEAD Community", members: 1804 },
    ];

    await backfillGroupNames(h.pool, h.gateway);
    const groups = await listGroups(h.pool, userId);
    assert.deepEqual(
      groups.map((g) => [g.name, g.members]).sort((a, b) => Number(a[1]) - Number(b[1])),
      [
        ["LEAD Community", 5],
        ["LEAD Community", 1804],
      ],
      "both Groups survive, and the size is what distinguishes them",
    );

    // Once nothing on the session is missing, the session stops being polled at
    // all — that is the 429 fix, and it means the count is a snapshot, not a
    // live figure. seedGroups refreshes it on the next reconnect; the backfill
    // deliberately does not keep asking.
    h.gateway.groupNames["sess-1"] = [
      { jid: "ann@g.us", name: "Renamed", members: 5 },
      { jid: "real@g.us", name: "Renamed", members: 1900 },
    ];
    await backfillGroupNames(h.pool, h.gateway);
    const after = await listGroups(h.pool, userId);
    assert.equal(after.find((g) => g.id === real)?.members, 1804, "converged: no re-poll");
    assert.equal(after.find((g) => g.id === real)?.name, "LEAD Community", "name is never rewritten");

    // Reconnecting is what refreshes it, and the name still stays put.
    await seedGroups(h.pool, h.gateway, "sess-1");
    const seeded = await listGroups(h.pool, userId);
    assert.equal(seeded.find((g) => g.id === real)?.members, 1900, "seed refreshes the count");
    assert.equal(seeded.find((g) => g.id === announce)?.members, 5);
    assert.equal(seeded.find((g) => g.id === real)?.name, "LEAD Community");
  });

  // The selection now also wakes on a NULL member count, so the convergence
  // stamp has to settle that too — otherwise a group the gateway stopped
  // listing keeps this session querying /groups forever, which is the exact
  // loop WhatsApp answered with 429 rate-overlimit and a closed stream.
  it("settles the member count too, so an unlisted group cannot re-open the 429 loop", async () => {
    const userId = await h.seedUser("tok");
    const sessionId = await h.seedSession(userId, "sess-1");
    await h.seedGroup(sessionId, "gone@g.us");
    h.gateway.groupNames["sess-1"] = [{ jid: "here@g.us", name: "Still Here", members: 12 }];

    await backfillGroupNames(h.pool, h.gateway);

    let calls = 0;
    h.gateway.listGroups = () => {
      calls += 1;
      return Promise.resolve([]);
    };
    await backfillGroupNames(h.pool, h.gateway);
    assert.equal(calls, 0, "the pass converged: nothing is left NULL to wake it");
  });

  // A row discovered from a message has no count until a listing is seen, and
  // the screen must simply omit it rather than claim the Group is empty.
  it("leaves the count null when the gateway never reported one", async () => {
    const userId = await h.seedUser("tok");
    const sessionId = await h.seedSession(userId, "sess-1");
    await h.seedGroup(sessionId, "hhh@g.us");
    h.gateway.groupNames["sess-1"] = [{ jid: "hhh@g.us", name: "No Count" }];

    await backfillGroupNames(h.pool, h.gateway);
    assert.equal((await listGroups(h.pool, userId))[0].members, null);
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
