import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { buildEvent, makeHarness, type Harness } from "./helpers.ts";
import { tickScheduler } from "../src/scheduler.ts";
import { renderSummary } from "../src/deliver.ts";
import { emptySummary } from "../src/summarize.ts";

// Ticket 6: one message a day, not one per Group Summary. The per-Group drain
// still runs — it marks Summaries delivered as it processes them — but it no
// longer touches the gateway. What the user receives is the day's pick.
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

const T = (iso: string) => new Date(iso);
// A UTC instant on today's UTC date — the day key the Brief and the digest
// clock both use, so an injected clock and the web path agree on "today".
const at = (hhmm: string) => new Date(`${new Date().toISOString().slice(0, 10)}T${hhmm}:00Z`);
const action = (text: string, ids: string[]) => ({
  text,
  source_message_ids: ids,
  owner: null,
  due_at: null,
  confidence: 1,
});

async function seedDeliverableSummary(): Promise<{ sessionId: string; groupId: string }> {
  const userId = await h.seedUser("tok");
  const sessionId = await h.seedSession(userId, "sess-1");
  const groupId = await h.seedGroup(sessionId, "group-1@g.us");
  const res = await h.api("tok", "PUT", `/v1/groups/${groupId}/schedule`, {
    local_time: "09:00",
    timezone: "Asia/Kuala_Lumpur",
    language: "en",
  });
  assert.equal(res.status, 200);
  const m1 = await h.seedMessage(groupId, "m1", "2026-07-30T00:30:00Z", {
    text: "Approved the RM500 order",
  });
  assert.equal((await tickScheduler(h.pool, T("2026-07-30T01:00:00Z"))).length, 1);
  h.summarizer.canned = {
    highlights: [{ text: "RM500 order approved", source_message_ids: [m1] }],
  };
  assert.equal(await h.summarize(), 1);
  return { sessionId, groupId };
}

// An Account with a connected Session, one Group, and a picked action item.
async function seedPickedDay(
  token = "tok",
): Promise<{ userId: string; groupId: string; keys: string[] }> {
  const userId = await h.seedUser(token);
  const sessionId = await h.seedSession(userId, "sess-1");
  const groupId = await h.seedGroup(sessionId, "group-1@g.us");
  await h.pool.query(`UPDATE groups SET name = 'Purchasing' WHERE id = $1`, [groupId]);
  const summaryId = await h.seedSummary(userId, groupId, {
    action_items: [action("Pay the vendor", ["m1"]), action("File the report", ["m2"])],
  });
  const keys = [`${summaryId}|action_items|0`];
  h.picker.canned = { headline: "One thing needs you today.", keys };
  return { userId, groupId, keys };
}

test("a Summary is marked delivered without any message being sent for it", async () => {
  await seedDeliverableSummary();

  assert.equal(await h.deliver(), 1);
  assert.equal(h.gateway.sends.length, 0); // no per-Group dump any more

  const { rows } = await h.pool.query(`SELECT delivered_at FROM summaries`);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].delivered_at !== null);

  // Next tick: nothing left to process.
  assert.equal(await h.deliver(), 0);
});

test("the per-Group renderer survives — it is still how a payload renders", () => {
  const payload = {
    ...emptySummary(),
    highlights: [{ text: "RM500 order approved", source_message_ids: ["m1"] }],
  };
  const text = renderSummary("Purchasing", T("2026-07-30T01:00:00Z"), payload, false);
  assert.match(text, /Purchasing/);
  assert.match(text, /RM500 order approved/);
  assert.doesNotMatch(text, /Incomplete/);
  assert.match(renderSummary("Purchasing", T("2026-07-30T01:00:00Z"), payload, true), /Incomplete/);
});

test("the day's message carries the headline, the numbered items and one link", async () => {
  await seedPickedDay();
  // The web path writes today's record; the drain sends it.
  assert.equal((await h.api("tok", "GET", "/v1/briefs/today")).status, 200);

  assert.equal(await h.digestSend(), 1);
  assert.equal(h.gateway.sends.length, 1);
  const text = h.gateway.sends[0].text;
  assert.equal(h.gateway.sends[0].sessionExternalId, "sess-1");
  assert.match(text, /One thing needs you today\./);
  assert.match(text, /1\. Pay the vendor — Purchasing/);
  assert.doesNotMatch(text, /File the report/); // not picked, not sent
  assert.match(text, /https:\/\/walao\.test\/today/);

  // Sent exactly once: delivered_at is the idempotency key, so a second tick
  // (or a restart between send and commit) does not produce a second message.
  assert.equal(await h.digestSend(), 0);
  assert.equal(h.gateway.sends.length, 1);
});

test("an empty pick says so rather than sending silence or an empty list", async () => {
  const userId = await h.seedUser("tok");
  await h.seedSession(userId, "sess-1");
  assert.equal((await h.api("tok", "PUT", "/v1/digest", { digest_time: "08:00", timezone: "UTC" })).status, 200);
  // No Summaries at all — the picker is never consulted, the record is empty.
  assert.equal(await h.digestTick(at("09:00")), 1);

  assert.equal(await h.digestSend(), 1);
  assert.equal(h.picker.calls.length, 0);
  assert.match(h.gateway.sends[0].text, /Nothing needs you today\./);
  assert.match(h.gateway.sends[0].text, /https:\/\/walao\.test\/today/);
});

test("an Account that never opens the web app still gets exactly one message a day", async () => {
  await seedPickedDay();
  assert.equal((await h.api("tok", "PUT", "/v1/digest", { digest_time: "08:00", timezone: "UTC" })).status, 200);

  // Before the chosen hour, nothing is written and nothing goes out.
  assert.equal(await h.digestTick(at("07:00")), 0);
  assert.equal(await h.digestSend(), 0);

  assert.equal(await h.digestTick(at("08:00")), 1);
  assert.equal(await h.digestTick(at("08:00")), 0); // already recorded
  assert.equal(await h.digestSend(), 1);
  assert.equal(h.gateway.sends.length, 1);
  assert.match(h.gateway.sends[0].text, /Pay the vendor/);

  // And the web path finds the record already there rather than writing a second.
  assert.equal((await h.api("tok", "GET", "/v1/briefs/today")).status, 200);
  assert.equal(await h.digestSend(), 0);
  assert.equal(h.gateway.sends.length, 1);
});

test("the digest time and timezone are settable, and an invalid zone is refused", async () => {
  const userId = await h.seedUser("tok");
  await h.seedSession(userId, "sess-tok");

  const initial = await h.api("tok", "GET", "/v1/digest");
  assert.deepEqual(initial.body, { digest_time: "08:00", timezone: "Asia/Kuala_Lumpur" });

  const ok = await h.api("tok", "PUT", "/v1/digest", {
    digest_time: "21:30",
    timezone: "Europe/Lisbon",
  });
  assert.equal(ok.status, 200);
  assert.deepEqual((await h.api("tok", "GET", "/v1/digest")).body, {
    digest_time: "21:30",
    timezone: "Europe/Lisbon",
  });

  for (const bad of [
    { digest_time: "21:30", timezone: "Mars/Olympus" },
    { digest_time: "25:00", timezone: "Europe/Lisbon" },
    { digest_time: "9am", timezone: "Europe/Lisbon" },
  ]) {
    const res = await h.api("tok", "PUT", "/v1/digest", bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
  // Refused means unchanged, not partially applied.
  assert.deepEqual((await h.api("tok", "GET", "/v1/digest")).body, {
    digest_time: "21:30",
    timezone: "Europe/Lisbon",
  });

  // 21:30 in Lisbon (UTC+1 in August) is 20:30 UTC.
  assert.equal(await h.digestTick(at("19:00")), 0);
  assert.equal(await h.digestTick(at("20:30")), 1);
});

test("no message goes out while the Account is blocked, or without a connected Session", async () => {
  await seedPickedDay();
  assert.equal((await h.api("tok", "GET", "/v1/briefs/today")).status, 200);

  await h.api("tok", "POST", "/v1/pause", {});
  assert.equal(await h.digestSend(), 0);
  assert.equal(h.gateway.sends.length, 0);
  await h.api("tok", "POST", "/v1/resume", {});

  await h.pool.query(`UPDATE whatsapp_sessions SET status = 'disconnected'`);
  assert.equal(await h.digestSend(), 0);
  assert.equal(h.gateway.sends.length, 0);

  // Reconnected, the waiting message goes out — the block postponed it, it did
  // not consume it.
  await h.pool.query(`UPDATE whatsapp_sessions SET status = 'connected'`);
  assert.equal(await h.digestSend(), 1);
  assert.equal(h.gateway.sends.length, 1);
});

test("a picked item whose Summary was purged is omitted, never rendered as an error", async () => {
  const { keys } = await seedPickedDay();
  assert.equal((await h.api("tok", "GET", "/v1/briefs/today")).status, 200);
  // The whole Summary the pick pointed at is gone by the time the send runs.
  await h.pool.query(`DELETE FROM summaries`);

  assert.equal(await h.digestSend(), 1);
  const text = h.gateway.sends[0].text;
  assert.match(text, /Nothing needs you today\./);
  assert.doesNotMatch(text, /undefined|null|error/i);
  assert.ok(keys.length > 0); // the record still holds the key; only the item is gone
});

test("Tier 0 boundary: the day's message targets the Account's own session only", async () => {
  await seedPickedDay();
  assert.equal((await h.api("tok", "GET", "/v1/briefs/today")).status, 200);
  assert.equal(await h.digestSend(), 1);

  for (const send of h.gateway.sends) {
    assert.equal(send.sessionExternalId, "sess-1");
    // The port carries no recipient at all — a group JID is inexpressible.
    assert.deepEqual(Object.keys(send).sort(), ["sessionExternalId", "text"]);
    assert.ok(!send.sessionExternalId.endsWith("@g.us"));
  }
});

// Ticket 7: a Group the Account holder cannot afford to miss pushes its window
// as soon as it holds something for them — the daily hour is for everything else.
async function seedIntervalGroup(): Promise<{ userId: string; groupId: string }> {
  const { userId, groupId } = await seedPickedDay();
  await h.pool.query(`UPDATE users SET plan = 'pro' WHERE id = $1`, [userId]);
  assert.equal(
    (
      await h.api("tok", "PUT", `/v1/groups/${groupId}/schedule`, {
        local_time: "09:00",
        timezone: "UTC",
        language: "en",
        interval_hours: 4,
      })
    ).status,
    200,
  );
  // The digest hour is hours away — anything that goes out now went out because
  // the Group pushed it, not because the clock came round.
  assert.equal(
    (await h.api("tok", "PUT", "/v1/digest", { digest_time: "23:59", timezone: "UTC" })).status,
    200,
  );
  return { userId, groupId };
}

test("an interval Group's window pushes the pick without waiting for the digest time", async () => {
  await seedIntervalGroup();

  assert.equal(await h.deliver(), 1); // the window's Summary lands
  assert.equal(await h.digestSend(), 1);
  assert.match(h.gateway.sends[0].text, /Pay the vendor/);

  // And the day's clock has nothing left to send when it does come round.
  assert.equal(await h.digestTick(at("23:59")), 0);
  assert.equal(await h.digestSend(), 0);
  assert.equal(h.gateway.sends.length, 1);
});

test("an interval window with nothing for the Account holder sends nothing", async () => {
  await seedIntervalGroup();
  h.picker.canned = { headline: "", keys: [] }; // candidates exist; none are for them

  assert.equal(await h.deliver(), 1);
  assert.equal(await h.digestSend(), 0);
  assert.equal(h.gateway.sends.length, 0);

  // The silence waits for the hour the Account chose, and then says so once.
  assert.equal(await h.digestTick(at("23:59")), 0); // the record already exists
  assert.equal(await h.digestSend(), 1);
  assert.match(h.gateway.sends[0].text, /Nothing needs you today\./);
});

test("a daily Group's Summary never pushes — its items wait for the daily message", async () => {
  const { groupId } = await seedPickedDay();
  assert.equal(
    (
      await h.api("tok", "PUT", `/v1/groups/${groupId}/schedule`, {
        local_time: "09:00",
        timezone: "UTC",
        language: "en",
      })
    ).status,
    200,
  );
  assert.equal(
    (await h.api("tok", "PUT", "/v1/digest", { digest_time: "23:59", timezone: "UTC" })).status,
    200,
  );

  assert.equal(await h.deliver(), 1);
  assert.equal(h.picker.calls.length, 0); // no pick is even computed
  assert.equal(await h.digestSend(), 0);
  assert.equal(h.gateway.sends.length, 0);
});

test("from_me echo of the day's message is not ingested or summarized", async () => {
  const { groupId } = await seedPickedDay();
  assert.equal((await h.api("tok", "GET", "/v1/briefs/today")).status, 200);
  assert.equal(await h.digestSend(), 1);
  const echoText = h.gateway.sends[0].text;

  // The message echoes back from the gateway as a from_me event.
  const status = await h.postWebhook(
    buildEvent({ id: "echo-1", fromMe: true, text: echoText, sentAt: new Date().toISOString() }),
  );
  assert.equal(status, 202);
  assert.equal(await h.drain(), 0); // dropped at ingress, nothing queued
  const { rows } = await h.pool.query(`SELECT 1 FROM messages WHERE external_id = 'echo-1'`);
  assert.equal(rows.length, 0);

  // A follow-up window over the echo's timestamp summarizes nothing.
  await h.pool.query(
    `INSERT INTO summary_jobs (group_id, language, window_start, window_end)
     VALUES ($1, 'en', now() - interval '1 hour', now() + interval '1 minute')`,
    [groupId],
  );
  const callsBefore = h.summarizer.calls.length;
  assert.equal(await h.summarize(), 1);
  assert.equal(h.summarizer.calls.length, callsBefore); // empty batch: model never consulted
  assert.ok(h.summarizer.calls.every((c) => c.messages.every((m) => m.text !== echoText)));
});
