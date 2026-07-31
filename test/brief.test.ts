import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, type Harness } from "./helpers.ts";
import type { TodayBrief } from "../src/brief.ts";

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

async function getBrief(token: string): Promise<TodayBrief> {
  const res = await h.api(token, "GET", "/v1/briefs/today");
  assert.equal(res.status, 200);
  return res.body as TodayBrief;
}

describe("today brief", () => {
  it("ranks items from all the user's groups into three buckets", async () => {
    const userId = await h.seedUser("tok-a");
    const sessionId = await h.seedSession(userId, "sess-1");
    const g1 = await h.seedGroup(sessionId, "g1@g.us");
    const g2 = await h.seedGroup(sessionId, "g2@g.us");
    await h.seedSummary(userId, g1, {
      action_items: [
        { text: "Pay vendor", source_message_ids: ["m1"], owner: null, due_at: null, confidence: 1 },
      ],
      decisions: [{ text: "Approved budget", source_message_ids: ["m2"] }],
    });
    await h.seedSummary(userId, g2, {
      open_questions: [{ text: "Who owns QA?", source_message_ids: ["m3"] }],
      highlights: [{ text: "Launch went well", source_message_ids: ["m4"] }],
    });
    // Another tenant's summary must not leak in.
    const otherId = await h.seedUser("tok-b");
    const otherSess = await h.seedSession(otherId, "sess-other");
    const otherGroup = await h.seedGroup(otherSess, "go@g.us");
    await h.seedSummary(otherId, otherGroup, {
      decisions: [{ text: "Secret decision", source_message_ids: ["mx"] }],
    });

    const brief = await getBrief("tok-a");
    assert.equal(brief.summary_count, 2);
    assert.deepEqual(
      brief.needs_action.map((i) => i.text).sort(),
      ["Pay vendor", "Who owns QA?"],
    );
    assert.deepEqual(brief.decided.map((i) => i.text), ["Approved budget"]);
    assert.deepEqual(brief.worth_noting.map((i) => i.text), ["Launch went well"]);
  });

  it("merges the same decision across groups keeping every source", async () => {
    const userId = await h.seedUser("tok-a");
    const sessionId = await h.seedSession(userId, "sess-1");
    const g1 = await h.seedGroup(sessionId, "g1@g.us");
    const g2 = await h.seedGroup(sessionId, "g2@g.us");
    await h.seedSummary(userId, g1, {
      decisions: [{ text: "Move launch to Friday", source_message_ids: ["m1", "m2"] }],
    });
    await h.seedSummary(userId, g2, {
      decisions: [{ text: "move launch to friday", source_message_ids: ["m9"] }],
    });

    const brief = await getBrief("tok-a");
    assert.equal(brief.decided.length, 1);
    const item = brief.decided[0];
    assert.equal(item.sources.length, 2);
    assert.deepEqual(item.sources.map((s) => s.group_id).sort(), [g1, g2].sort());
    assert.deepEqual(
      item.sources.flatMap((s) => s.source_message_ids).sort(),
      ["m1", "m2", "m9"],
    );
  });

  it("builds from stored summaries only — raw messages already purged", async () => {
    const userId = await h.seedUser("tok-a");
    const sessionId = await h.seedSession(userId, "sess-1");
    const g1 = await h.seedGroup(sessionId, "g1@g.us");
    await h.seedSummary(userId, g1, {
      decisions: [{ text: "Renew contract", source_message_ids: ["gone-1"] }],
    });
    // No rows in messages at all — the cited raw text is beyond retention.
    const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM messages`);
    assert.equal(rows[0].n, 0);

    const brief = await getBrief("tok-a");
    assert.deepEqual(brief.decided.map((i) => i.text), ["Renew contract"]);
    assert.deepEqual(brief.decided[0].sources[0].source_message_ids, ["gone-1"]);
  });

  it("returns an explicit empty brief when today has no summaries", async () => {
    const userId = await h.seedUser("tok-a");
    const sessionId = await h.seedSession(userId, "sess-1");
    const g1 = await h.seedGroup(sessionId, "g1@g.us");
    // A stale summary outside the 24h window must not count as today.
    await h.seedSummary(
      userId,
      g1,
      { decisions: [{ text: "Old news", source_message_ids: ["m1"] }] },
      { at: new Date(Date.now() - 3 * 24 * 3600_000) },
    );

    const brief = await getBrief("tok-a");
    assert.equal(brief.summary_count, 0);
    assert.deepEqual(brief.needs_action, []);
    assert.deepEqual(brief.decided, []);
    assert.deepEqual(brief.worth_noting, []);
    assert.match(brief.date, /^\d{4}-\d{2}-\d{2}$/);
  });
});
