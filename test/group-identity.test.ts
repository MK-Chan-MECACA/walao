// A Group belongs to the Account, but groups rows are keyed per Session and
// re-pairing mints a new one. These tests pin the invariant that survives that:
// one row per Group on screen, the Account's choices on the Session that is
// actually carrying messages, and a cap that counts Groups rather than rows.
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, type Harness } from "./helpers.ts";
import { adoptGroups, listGroups } from "../src/subscriptions.ts";
import { getUsage } from "../src/billing.ts";

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

const setStatus = (externalSessionId: string, status: string) =>
  h.pool.query(`UPDATE whatsapp_sessions SET status = $2 WHERE external_session_id = $1`, [
    externalSessionId,
    status,
  ]);

const enabledOf = async (groupId: string): Promise<boolean> => {
  const { rows } = await h.pool.query(`SELECT enabled FROM groups WHERE id = $1`, [groupId]);
  return rows[0].enabled;
};

// The shape a re-pair leaves behind: the old Session holds the Account's
// choices, the new one has been seeded with everything disabled.
async function rePaired() {
  const userId = await h.seedUser("tok");
  const oldSession = await h.seedSession(userId, "sess-old");
  const newSession = await h.seedSession(userId, "sess-new");
  await setStatus("sess-old", "disconnected");
  await setStatus("sess-new", "connected");

  const oldOn = await h.seedGroup(oldSession, "aaa@g.us", true);
  const oldOff = await h.seedGroup(oldSession, "bbb@g.us", false);
  const newOn = await h.seedGroup(newSession, "aaa@g.us", false);
  const newOff = await h.seedGroup(newSession, "bbb@g.us", false);
  await h.pool.query(`UPDATE groups SET enabled_at = now() - interval '1 day' WHERE id = $1`, [
    oldOn,
  ]);
  return { userId, oldSession, newSession, oldOn, oldOff, newOn, newOff };
}

describe("group identity across a re-pair", () => {
  it("shows each Group once, on the Session that is actually live", async () => {
    const { userId, newOn, newOff } = await rePaired();

    const groups = await listGroups(h.pool, userId);
    assert.deepEqual(
      groups.map((g) => g.external_jid).sort(),
      ["aaa@g.us", "bbb@g.us"],
      "a Group the Account has re-paired into must not appear twice",
    );
    // The row shown is the live Session's, so enabling it reaches the Session
    // consumer.ts will resolve the incoming message against.
    assert.deepEqual(groups.map((g) => g.id).sort(), [newOn, newOff].sort());
  });

  it("carries the Account's choices onto the live Session and stands the old rows down", async () => {
    const { userId, oldOn, newOn } = await rePaired();

    assert.equal(await adoptGroups(h.pool, "sess-new"), 1);
    assert.equal(await enabledOf(newOn), true, "the live row must carry the choice");
    assert.equal(await enabledOf(oldOn), false, "the superseded row must stop counting");

    // enabled_at travels too: the cap breaks ties by it, so a re-pair must not
    // silently re-rank which Groups the cap blocks.
    const { rows } = await h.pool.query(`SELECT enabled_at FROM groups WHERE id = $1`, [newOn]);
    assert.ok(rows[0].enabled_at < new Date(), "adopted enabled_at is the original, not now()");

    // Idempotent: re-running adopts nothing further.
    assert.equal(await adoptGroups(h.pool, "sess-new"), 0);
  });

  it("keeps a Group the live Session does not carry rather than silently disabling it", async () => {
    const userId = await h.seedUser("tok");
    const oldSession = await h.seedSession(userId, "sess-old");
    await h.seedSession(userId, "sess-new");
    await setStatus("sess-old", "disconnected");
    await setStatus("sess-new", "connected");
    // Enabled on the old Session, and absent from the new one — WhatsApp did
    // not return it this time. Its state must survive.
    const orphan = await h.seedGroup(oldSession, "ccc@g.us", true);

    await adoptGroups(h.pool, "sess-new");
    assert.equal(await enabledOf(orphan), true);

    const groups = await listGroups(h.pool, userId);
    assert.deepEqual(groups.map((g) => g.id), [orphan], "it is still the Account's only copy");
  });

  it("counts the cap per Group, so a stale copy cannot burn a Plan slot", async () => {
    const { userId } = await rePaired();
    // Both copies of aaa@g.us enabled at once — the state the bug produced.
    await h.pool.query(`UPDATE groups SET enabled = true WHERE external_jid = 'aaa@g.us'`);

    const usage = await getUsage(h.pool, userId);
    assert.equal(usage.usage.enabled_groups, 1, "one Group is enabled, not two rows' worth");
  });

  it("moves the summary schedule onto the live row", async () => {
    const { userId, oldOn, newOn } = await rePaired();
    await h.pool.query(
      `INSERT INTO summary_schedules (group_id, local_time, timezone, language)
       VALUES ($1, '22:00', 'Asia/Kuala_Lumpur', 'en')`,
      [oldOn],
    );

    await adoptGroups(h.pool, "sess-new");

    const { rows } = await h.pool.query(
      `SELECT local_time, timezone, language FROM summary_schedules WHERE group_id = $1`,
      [newOn],
    );
    assert.deepEqual(rows, [{ local_time: "22:00", timezone: "Asia/Kuala_Lumpur", language: "en" }]);

    // And the Groups screen reads it off the row it now shows.
    const shown = (await listGroups(h.pool, userId)).find((g) => g.id === newOn);
    assert.equal(shown?.schedule?.local_time, "22:00");
  });
});
