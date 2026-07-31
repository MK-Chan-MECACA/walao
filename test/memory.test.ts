import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, type Harness } from "./helpers.ts";
import type { Memory, MemoryCandidate, WeeklyReview } from "../src/memory.ts";

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

async function seedTenant(token: string): Promise<{ userId: string; groupId: string }> {
  const userId = await h.seedUser(token);
  const sessionId = await h.seedSession(userId, `sess-${token}`);
  const groupId = await h.seedGroup(sessionId, `${token}@g.us`);
  return { userId, groupId };
}

const CANDIDATE = {
  memory_candidates: [
    { text: "Supplier A's payment term is 30 days", source_message_ids: ["m1", "m2"] },
  ],
};

async function candidates(token: string): Promise<MemoryCandidate[]> {
  const res = await h.api(token, "GET", "/v1/memories/candidates");
  assert.equal(res.status, 200);
  return (res.body as { candidates: MemoryCandidate[] }).candidates;
}

async function memories(token: string): Promise<Memory[]> {
  const res = await h.api(token, "GET", "/v1/memories");
  assert.equal(res.status, 200);
  return (res.body as { memories: Memory[] }).memories;
}

describe("memory beta", () => {
  it("candidates from summaries appear for review with source references, tenant-scoped", async () => {
    const { userId, groupId } = await seedTenant("tok-a");
    const sid = await h.seedSummary(userId, groupId, CANDIDATE);
    // Another tenant's candidate must not leak in.
    const other = await seedTenant("tok-b");
    await h.seedSummary(other.userId, other.groupId, CANDIDATE);

    const list = await candidates("tok-a");
    assert.equal(list.length, 1);
    assert.equal(list[0].summary_id, sid);
    assert.equal(list[0].item_index, 0);
    assert.equal(list[0].text, "Supplier A's payment term is 30 days");
    assert.deepEqual(list[0].source_message_ids, ["m1", "m2"]);
    assert.equal(list[0].jump_url, "whatsapp://chat?jid=tok-a%40g.us");
  });

  it("an unconfirmed candidate expires with its window; a confirmed one persists until deleted", async () => {
    const { userId, groupId } = await seedTenant("tok-a");
    const expiredSid = await h.seedSummary(
      userId,
      groupId,
      CANDIDATE,
      { at: new Date(Date.now() - 8 * 24 * 3600_000) }, // clock 8 days past proposal
    );
    const freshSid = await h.seedSummary(userId, groupId, CANDIDATE);

    // Only the in-window candidate is up for review; the expired one is gone
    // and can no longer be confirmed.
    const list = await candidates("tok-a");
    assert.deepEqual(list.map((c) => c.summary_id), [freshSid]);
    const expired = await h.api(
      "tok-a",
      "POST",
      `/v1/summaries/${expiredSid}/memory-candidates/0/confirm`,
    );
    assert.equal(expired.status, 400);
    assert.deepEqual(expired.body, { error: "candidate_expired" });

    // Confirm the fresh one, then advance the clock past the window: the
    // candidate list is empty but the memory persists — until deleted.
    const confirmed = await h.api(
      "tok-a",
      "POST",
      `/v1/summaries/${freshSid}/memory-candidates/0/confirm`,
    );
    assert.equal(confirmed.status, 201);
    await h.pool.query(`UPDATE summaries SET created_at = now() - interval '9 days' WHERE id = $1`, [
      freshSid,
    ]);
    assert.deepEqual(await candidates("tok-a"), []);
    let mems = await memories("tok-a");
    assert.equal(mems.length, 1);
    assert.equal(
      (await h.api("tok-a", "DELETE", `/v1/memories/${mems[0].id}`)).status,
      200,
    );
    assert.deepEqual(await memories("tok-a"), []);
  });

  it("confirmed memories are listable, editable, exportable, deletable, and idempotent to confirm", async () => {
    const { userId, groupId } = await seedTenant("tok-a");
    const sid = await h.seedSummary(userId, groupId, CANDIDATE);
    const path = `/v1/summaries/${sid}/memory-candidates/0/confirm`;
    const created = (await h.api("tok-a", "POST", path)).body as Memory;
    // Confirming twice stays one memory; the confirmed candidate leaves review.
    await h.api("tok-a", "POST", path);
    assert.equal((await memories("tok-a")).length, 1);
    assert.deepEqual(await candidates("tok-a"), []);

    // Edit content; source trail is immutable.
    const edited = await h.api("tok-a", "PUT", `/v1/memories/${created.id}`, {
      content: "Supplier A: 45-day payment term (renegotiated)",
    });
    assert.equal(edited.status, 200);
    assert.equal((edited.body as Memory).content, "Supplier A: 45-day payment term (renegotiated)");
    assert.deepEqual((edited.body as Memory).source.source_message_ids, ["m1", "m2"]);
    assert.equal((await h.api("tok-a", "PUT", `/v1/memories/${created.id}`, { content: "" })).status, 400);

    // Export carries memories.
    const exported = (await h.api("tok-a", "GET", "/v1/export")).body as {
      memories: { content: string }[];
    };
    assert.equal(exported.memories.length, 1);
    assert.equal(exported.memories[0].content, "Supplier A: 45-day payment term (renegotiated)");

    // Cross-tenant edit/delete look like not-found; out-of-range confirm is invalid.
    await h.seedUser("tok-b");
    assert.equal((await h.api("tok-b", "PUT", `/v1/memories/${created.id}`, { content: "x" })).status, 404);
    assert.equal((await h.api("tok-b", "DELETE", `/v1/memories/${created.id}`)).status, 404);
    assert.equal(
      (await h.api("tok-a", "POST", `/v1/summaries/${sid}/memory-candidates/9/confirm`)).status,
      400,
    );
  });

  it("each memory exposes content, source, created-at, confirmer, and last-used-at", async () => {
    const { userId, groupId } = await seedTenant("tok-a");
    const sid = await h.seedSummary(userId, groupId, CANDIDATE);
    const mem = (await h.api("tok-a", "POST", `/v1/summaries/${sid}/memory-candidates/0/confirm`))
      .body as Memory;
    assert.equal(mem.content, "Supplier A's payment term is 30 days");
    assert.deepEqual(mem.source, {
      summary_id: sid,
      group_jid: "tok-a@g.us",
      jump_url: "whatsapp://chat?jid=tok-a%40g.us",
      source_message_ids: ["m1", "m2"],
    });
    assert.ok(!Number.isNaN(Date.parse(mem.created_at)));
    assert.equal(mem.confirmed_by, userId);
    assert.equal(mem.last_used_at, null);
  });

  it("weekly review digests decisions, overdue items, and recurring risks daily briefs miss", async () => {
    const { userId, groupId } = await seedTenant("tok-a");
    // Two summaries days apart — outside any single Today Brief window.
    const s1 = await h.seedSummary(
      userId,
      groupId,
      {
        decisions: [{ text: "Switch to Supplier B", source_message_ids: ["m1"] }],
        open_questions: [{ text: "Who owns the audit?", source_message_ids: ["m2"] }],
        action_items: [
          { text: "Send invoice", source_message_ids: ["m3"], owner: null, due_at: "2026-07-01T00:00:00Z", confidence: 1 },
        ],
      },
      { at: new Date(Date.now() - 5 * 24 * 3600_000) },
    );
    await h.seedSummary(userId, groupId, {
      open_questions: [
        { text: "who owns the audit?", source_message_ids: ["m4"] }, // recurring (case-insensitive)
        { text: "One-off question", source_message_ids: ["m5"] },
      ],
    });
    // Only a confirmed, past-due, still-open reminder counts as overdue.
    await h.api("tok-a", "POST", `/v1/summaries/${s1}/action-items/0/confirm`);

    const review = (await h.api("tok-a", "GET", "/v1/review/weekly")).body as WeeklyReview;
    assert.equal(review.summary_count, 2);
    assert.deepEqual(review.decisions.map((d) => d.text), ["Switch to Supplier B"]);
    assert.equal(review.overdue.length, 1);
    assert.equal(review.overdue[0].text, "Send invoice");
    // Recurring = same question in ≥2 summaries; the one-off is excluded.
    assert.equal(review.recurring_risks.length, 1);
    assert.equal(review.recurring_risks[0].occurrences, 2);
    assert.equal(review.recurring_risks[0].sources.length, 2);
  });
});
