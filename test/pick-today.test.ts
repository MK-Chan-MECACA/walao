import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, type Harness } from "./helpers.ts";

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

type BriefBody = { pick: { headline: string; keys: string[] } };

async function getBrief(token: string): Promise<BriefBody> {
  const res = await h.api(token, "GET", "/v1/briefs/today");
  assert.equal(res.status, 200);
  return res.body as BriefBody;
}

function action(text: string, ids: string[] = ["m1"]) {
  return { text, source_message_ids: ids, owner: null, due_at: null, confidence: 1 };
}

describe("today pick", () => {
  it("serves the picked keys and headline on the brief", async () => {
    const userId = await h.seedUser("tok-a");
    const sessionId = await h.seedSession(userId, "sess-1");
    const groupId = await h.seedGroup(sessionId, "g1@g.us");
    const summaryId = await h.seedSummary(userId, groupId, {
      action_items: [action("Pay vendor"), action("File report", ["m2"])],
    });
    h.picker.canned = { headline: "One thing needs you", keys: [`${summaryId}|action_items|1`] };

    const brief = await getBrief("tok-a");
    assert.equal(brief.pick.headline, "One thing needs you");
    assert.deepEqual(brief.pick.keys, [`${summaryId}|action_items|1`]);
  });

  it("calls the picker once and serves the cache on the next load", async () => {
    const userId = await h.seedUser("tok-a");
    const sessionId = await h.seedSession(userId, "sess-1");
    const groupId = await h.seedGroup(sessionId, "g1@g.us");
    await h.seedSummary(userId, groupId, { action_items: [action("Pay vendor")] });
    h.picker.canned = { headline: "One thing", keys: [] };

    await getBrief("tok-a");
    await getBrief("tok-a");
    await getBrief("tok-a");

    assert.equal(h.picker.calls.length, 1);
  });

  it("re-picks when a new summary lands", async () => {
    const userId = await h.seedUser("tok-a");
    const sessionId = await h.seedSession(userId, "sess-1");
    const groupId = await h.seedGroup(sessionId, "g1@g.us");
    await h.seedSummary(userId, groupId, { action_items: [action("Pay vendor")] });
    await getBrief("tok-a");

    await h.seedSummary(userId, groupId, { action_items: [action("File report", ["m2"])] });
    await getBrief("tok-a");

    assert.equal(h.picker.calls.length, 2);
  });

  it("a day with no summaries costs no model call", async () => {
    await h.seedUser("tok-a");
    const brief = await getBrief("tok-a");
    assert.deepEqual(brief.pick, { headline: "", keys: [] });
    assert.equal(h.picker.calls.length, 0);
  });

  it("never offers a cleared item to the picker", async () => {
    const userId = await h.seedUser("tok-a");
    const sessionId = await h.seedSession(userId, "sess-1");
    const groupId = await h.seedGroup(sessionId, "g1@g.us");
    const summaryId = await h.seedSummary(userId, groupId, {
      action_items: [action("Pay vendor"), action("File report", ["m2"])],
    });
    await h.api("tok-a", "PUT", `/v1/summaries/${summaryId}/items/action_items/0/state`, {
      state: "dismissed",
    });

    await getBrief("tok-a");

    assert.deepEqual(
      h.picker.calls[0].candidates.map((c) => c.text),
      ["File report"],
    );
  });

  it("drops a key the picker invented", async () => {
    const userId = await h.seedUser("tok-a");
    const sessionId = await h.seedSession(userId, "sess-1");
    const groupId = await h.seedGroup(sessionId, "g1@g.us");
    await h.seedSummary(userId, groupId, { action_items: [action("Pay vendor")] });
    h.picker.canned = { headline: "made up", keys: ["not-a-real-key"] };

    assert.deepEqual((await getBrief("tok-a")).pick.keys, []);
  });

  // The message body is stored encrypted under the Account's own key, so this
  // passing at all means tagging read it through envelope decryption (ADR-0002).
  it("marks an item tagged when its source message @mentions the account holder", async () => {
    const userId = await h.seedUser("tok-a");
    const sessionId = await h.seedSession(userId, "sess-1");
    await h.pool.query(`UPDATE whatsapp_sessions SET self_phone = $2 WHERE id = $1`, [
      sessionId,
      "60123456789@s.whatsapp.net",
    ]);
    const groupId = await h.seedGroup(sessionId, "g1@g.us");
    const msgId = await h.seedMessage(groupId, "m1", new Date().toISOString(), {
      text: "@60123456789 can you confirm the format?",
    });
    const other = await h.seedMessage(groupId, "m2", new Date().toISOString(), {
      text: "@601234567891234 please look",
    });
    await h.seedSummary(userId, groupId, {
      open_questions: [
        { text: "Is the format OK?", source_message_ids: [msgId] },
        { text: "Anything on the quote?", source_message_ids: [other] },
      ],
    });

    await getBrief("tok-a");

    const tagged = Object.fromEntries(h.picker.calls[0].candidates.map((c) => [c.text, c.tagged]));
    assert.deepEqual(tagged, { "Is the format OK?": true, "Anything on the quote?": false });
  });

  // Past raw expiry the source message is gone; the mention survives only as the
  // resolved @Name the item text already carries.
  it("falls back to the resolved @Name once the raw message is gone", async () => {
    const userId = await h.seedUser("tok-a");
    const sessionId = await h.seedSession(userId, "sess-1");
    await h.pool.query(
      `UPDATE whatsapp_sessions SET self_phone = $2, self_name = $3 WHERE id = $1`,
      [sessionId, "60123456789@s.whatsapp.net", "MK Chan"],
    );
    const groupId = await h.seedGroup(sessionId, "g1@g.us");
    await h.seedSummary(userId, groupId, {
      action_items: [action("@MK Chan to redo the banner", ["gone"])],
    });

    await getBrief("tok-a");

    assert.equal(h.picker.calls[0].candidates[0].tagged, true);
  });

  it("tags nothing for an account whose identity is unknown", async () => {
    const userId = await h.seedUser("tok-a");
    const sessionId = await h.seedSession(userId, "sess-1");
    const groupId = await h.seedGroup(sessionId, "g1@g.us");
    const msgId = await h.seedMessage(groupId, "m1", new Date().toISOString(), {
      text: "@60123456789 can you confirm?",
    });
    await h.seedSummary(userId, groupId, {
      open_questions: [{ text: "Is the format OK?", source_message_ids: [msgId] }],
    });

    await getBrief("tok-a");

    assert.equal(h.picker.calls[0].candidates[0].tagged, false);
  });

  it("never shows one account's items to another account's pick", async () => {
    const a = await h.seedUser("tok-a");
    const b = await h.seedUser("tok-b");
    const groupA = await h.seedGroup(await h.seedSession(a, "sess-a"), "ga@g.us");
    const groupB = await h.seedGroup(await h.seedSession(b, "sess-b"), "gb@g.us");
    await h.seedSummary(a, groupA, { action_items: [action("A's vendor")] });
    await h.seedSummary(b, groupB, { action_items: [action("B's vendor", ["m2"])] });

    await getBrief("tok-b");

    assert.deepEqual(
      h.picker.calls[0].candidates.map((c) => c.text),
      ["B's vendor"],
    );
  });
});
