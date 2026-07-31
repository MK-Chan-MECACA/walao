import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, type Harness } from "./helpers.ts";
import { emptySummary, type SummaryPayload } from "../src/summarize.ts";
import type { Reminder, SummaryHistoryEntry } from "../src/surfaces.ts";
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

async function seedSummary(
  userId: string,
  groupId: string,
  payload: Partial<SummaryPayload>,
  createdAt: Date = new Date(),
): Promise<string> {
  const { rows } = await h.pool.query(
    `INSERT INTO summaries
       (user_id, group_id, language, window_start, window_end, payload,
        model, prompt_version, input_tokens, output_tokens, duration_ms, created_at)
     VALUES ($1, $2, 'en', $3, $4, $5, 't', 't', 0, 0, 0, $6) RETURNING id`,
    [
      userId,
      groupId,
      new Date(createdAt.getTime() - 3600_000),
      createdAt,
      JSON.stringify({ ...emptySummary(), ...payload }),
      createdAt,
    ],
  );
  return rows[0].id;
}

async function listHistory(token: string): Promise<SummaryHistoryEntry[]> {
  const res = await h.api(token, "GET", "/v1/summaries");
  assert.equal(res.status, 200);
  return (res.body as { summaries: SummaryHistoryEntry[] }).summaries;
}

const ACTION = {
  action_items: [
    {
      text: "Pay vendor",
      source_message_ids: ["m1"],
      owner: "alice",
      due_at: "2026-08-01T00:00:00Z",
      confidence: 1,
    },
    { text: "Book venue", source_message_ids: ["m2"], owner: null, due_at: null, confidence: 1 },
  ],
};

describe("app surfaces", () => {
  it("history lists summaries within 90 days with jump-back links, tenant-scoped", async () => {
    const userId = await h.seedUser("tok-a");
    const sessionId = await h.seedSession(userId, "sess-1");
    const g1 = await h.seedGroup(sessionId, "g1@g.us");
    const recent = await seedSummary(userId, g1, {
      decisions: [{ text: "Approved budget", source_message_ids: ["m1"] }],
    });
    await seedSummary(userId, g1, {}, new Date(Date.now() - 100 * 24 * 3600_000));
    // Another tenant's summary must not leak in.
    const otherId = await h.seedUser("tok-b");
    const otherSess = await h.seedSession(otherId, "sess-o");
    const og = await h.seedGroup(otherSess, "go@g.us");
    await seedSummary(otherId, og, {});

    const list = await listHistory("tok-a");
    assert.equal(list.length, 1);
    assert.equal(list[0].id, recent);
    assert.equal(list[0].group_name, null);
    assert.equal(list[0].chat_jid, "g1@g.us");
    assert.equal(list[0].jump_url, "whatsapp://chat?jid=g1%40g.us");
    assert.deepEqual(list[0].payload.decisions.map((d) => d.text), ["Approved budget"]);
    // Brief item sources carry the same jump-back link.
    const brief = (await h.api("tok-a", "GET", "/v1/briefs/today")).body as TodayBrief;
    assert.equal(brief.decided[0].sources[0].jump_url, "whatsapp://chat?jid=g1%40g.us");
  });

  it("item complete/dismiss state persists across sessions and is tenant-scoped", async () => {
    const userId = await h.seedUser("tok-a");
    const sessionId = await h.seedSession(userId, "sess-1");
    const g1 = await h.seedGroup(sessionId, "g1@g.us");
    const sid = await seedSummary(userId, g1, {
      highlights: [
        { text: "One", source_message_ids: ["m1"] },
        { text: "Two", source_message_ids: ["m2"] },
      ],
    });

    const base = `/v1/summaries/${sid}/items/highlights`;
    assert.equal((await h.api("tok-a", "PUT", `${base}/0/state`, { state: "complete" })).status, 200);
    assert.equal((await h.api("tok-a", "PUT", `${base}/1/state`, { state: "dismissed" })).status, 200);
    // Fresh fetch = new session: state comes back from the store.
    let states = (await listHistory("tok-a"))[0].states;
    assert.deepEqual(
      states.sort((a, b) => a.item_index - b.item_index),
      [
        { section: "highlights", item_index: 0, state: "complete" },
        { section: "highlights", item_index: 1, state: "dismissed" },
      ],
    );
    // Clearing with null removes the state row.
    assert.equal((await h.api("tok-a", "PUT", `${base}/1/state`, { state: null })).status, 200);
    states = (await listHistory("tok-a"))[0].states;
    assert.deepEqual(states, [{ section: "highlights", item_index: 0, state: "complete" }]);

    // Out-of-range index and unknown section are invalid.
    assert.equal((await h.api("tok-a", "PUT", `${base}/9/state`, { state: "complete" })).status, 400);
    assert.equal(
      (await h.api("tok-a", "PUT", `/v1/summaries/${sid}/items/nope/0/state`, { state: "complete" }))
        .status,
      400,
    );
    // Cross-tenant looks like not-found, never invalid.
    await h.seedUser("tok-b");
    assert.equal((await h.api("tok-b", "PUT", `${base}/0/state`, { state: "complete" })).status, 404);
  });

  it("a reminder exists only after explicit confirmation; unconfirmed items never fire", async () => {
    const userId = await h.seedUser("tok-a");
    const sessionId = await h.seedSession(userId, "sess-1");
    const g1 = await h.seedGroup(sessionId, "g1@g.us");
    const sid = await seedSummary(userId, g1, ACTION);

    // Two extracted action items, zero reminders — extraction alone triggers nothing.
    let reminders = (await h.api("tok-a", "GET", "/v1/reminders")).body as { reminders: Reminder[] };
    assert.deepEqual(reminders.reminders, []);

    const res = await h.api("tok-a", "POST", `/v1/summaries/${sid}/action-items/0/confirm`);
    assert.equal(res.status, 201);
    const created = res.body as Reminder;
    assert.equal(created.text, "Pay vendor");
    assert.equal(created.owner, "alice");
    assert.equal(created.due_at, "2026-08-01T00:00:00.000Z");
    assert.equal(created.status, "open");
    assert.equal(created.jump_url, "whatsapp://chat?jid=g1%40g.us");

    // Confirming twice stays one reminder; the unconfirmed sibling never appears.
    await h.api("tok-a", "POST", `/v1/summaries/${sid}/action-items/0/confirm`);
    reminders = (await h.api("tok-a", "GET", "/v1/reminders")).body as { reminders: Reminder[] };
    assert.equal(reminders.reminders.length, 1);

    // Out-of-range item and cross-tenant summary are rejected.
    assert.equal(
      (await h.api("tok-a", "POST", `/v1/summaries/${sid}/action-items/9/confirm`)).status,
      400,
    );
    await h.seedUser("tok-b");
    assert.equal(
      (await h.api("tok-b", "POST", `/v1/summaries/${sid}/action-items/0/confirm`)).status,
      404,
    );
  });

  it("confirmed reminders carry owner, due date, and status, editable by the user", async () => {
    const userId = await h.seedUser("tok-a");
    const sessionId = await h.seedSession(userId, "sess-1");
    const g1 = await h.seedGroup(sessionId, "g1@g.us");
    const sid = await seedSummary(userId, g1, ACTION);
    // Body overrides beat the extracted defaults at confirmation time.
    const created = (
      await h.api("tok-a", "POST", `/v1/summaries/${sid}/action-items/1/confirm`, {
        owner: "bob",
        due_at: "2026-08-15T09:00:00Z",
      })
    ).body as Reminder;
    assert.equal(created.owner, "bob");
    assert.equal(created.due_at, "2026-08-15T09:00:00.000Z");

    const edited = await h.api("tok-a", "PUT", `/v1/reminders/${created.id}`, {
      owner: "carol",
      due_at: "2026-09-01T00:00:00Z",
      status: "done",
    });
    assert.equal(edited.status, 200);
    const after = (await h.api("tok-a", "GET", "/v1/reminders")).body as { reminders: Reminder[] };
    assert.equal(after.reminders[0].owner, "carol");
    assert.equal(after.reminders[0].due_at, "2026-09-01T00:00:00.000Z");
    assert.equal(after.reminders[0].status, "done");

    assert.equal(
      (await h.api("tok-a", "PUT", `/v1/reminders/${created.id}`, { status: "nope" })).status,
      400,
    );
    assert.equal(
      (await h.api("tok-a", "PUT", `/v1/reminders/${created.id}`, { due_at: "not-a-date" })).status,
      400,
    );
    await h.seedUser("tok-b");
    assert.equal(
      (await h.api("tok-b", "PUT", `/v1/reminders/${created.id}`, { status: "done" })).status,
      404,
    );
  });
});
