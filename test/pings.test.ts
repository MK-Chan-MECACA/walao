import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { buildEvent, makeHarness, type Harness } from "./helpers.ts";
import { PING_PER_HOUR } from "../src/pings.ts";
import { purgeExpired } from "../src/retention.ts";

// Ticket 8: the only unprompted interruption in the product. A mention that
// genuinely needs the Account holder reaches them in minutes; a thank-you
// reaches them never.
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

// The Account holder's two addressing forms plus the name they post under.
const SELF = { phone: "60123456789", lid: "112476687458485", name: "MK Chan" };

async function seedAccount(): Promise<{ userId: string; sessionId: string; groupId: string }> {
  const userId = await h.seedUser("tok");
  const sessionId = await h.seedSession(userId, "sess-1");
  await h.pool.query(
    `UPDATE whatsapp_sessions SET self_phone = $2, self_lid = $3, self_name = $4 WHERE id = $1`,
    [sessionId, SELF.phone, SELF.lid, SELF.name],
  );
  const groupId = await h.seedGroup(sessionId, "group-1@g.us");
  await h.pool.query(`UPDATE groups SET name = 'Purchasing' WHERE id = $1`, [groupId]);
  return { userId, sessionId, groupId };
}

// Deliver one group message through the real webhook and the real drain, so
// detection is exercised where it actually lives.
async function say(text: string, id = "msg-1"): Promise<void> {
  assert.equal(await h.postWebhook(buildEvent({ id, text })), 202);
  await h.drain();
}

async function pending(): Promise<number> {
  const { rows } = await h.pool.query(
    `SELECT count(*)::int AS n FROM mention_pings WHERE resolved_at IS NULL`,
  );
  return rows[0].n;
}

async function queued(): Promise<number> {
  const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM mention_pings`);
  return rows[0].n;
}

test("a mention of the Account holder is queued; one of somebody else is not", async () => {
  await seedAccount();

  await say(`@${SELF.phone} can you approve this`, "m1");
  assert.equal(await queued(), 1);

  await say("@60999888777 can you approve this", "m2");
  assert.equal(await queued(), 1);
});

test("a longer id that merely begins with the Account holder's digits is not queued", async () => {
  await seedAccount();
  await say(`@${SELF.phone}1234 look at this`, "m1");
  assert.equal(await queued(), 0);
});

test("either of the Account holder's two addressing forms is recognised", async () => {
  await seedAccount();

  await say(`@${SELF.phone} phone-form mention`, "m1");
  await say(`@${SELF.lid} lid-form mention`, "m2");

  assert.equal(await queued(), 2);
});

test("a replayed webhook event cannot queue the same message twice", async () => {
  await seedAccount();
  const evt = buildEvent({ id: "m1", text: `@${SELF.phone} please confirm` });

  assert.equal(await h.postWebhook(evt), 202);
  await h.drain();
  assert.equal(await h.postWebhook(evt), 202);
  await h.drain();

  assert.equal(await queued(), 1);
});

test("a mention judged as needing the user produces one ping naming its Group", async () => {
  await seedAccount();
  await say(`@${SELF.phone} can you approve the RM500 order`);

  h.picker.echo = true;
  h.picker.headline = "Purchasing is waiting on your approval.";
  assert.equal(await h.pingTick(), 1);

  assert.equal(h.gateway.sends.length, 1);
  const text = h.gateway.sends[0].text;
  assert.ok(text.includes("Purchasing"), text);
  assert.ok(text.includes("waiting on your approval"), text);

  // The judgement saw the decrypted body — ADR-0002's envelope, read once,
  // where the plaintext already was.
  assert.equal(h.picker.calls.length, 1);
  const candidate = h.picker.calls[0].candidates[0];
  assert.equal(candidate.text, `@${SELF.phone} can you approve the RM500 order`);
  assert.equal(candidate.tagged, true);
  assert.equal(h.picker.calls[0].self_name, SELF.name);

  // Resolved: a second tick neither re-judges nor re-sends.
  assert.equal(await h.pingTick(), 0);
  assert.equal(h.picker.calls.length, 1);
  assert.equal(h.gateway.sends.length, 1);
});

test("a mention judged as needing nothing sends nothing and is never judged again", async () => {
  await seedAccount();
  await say(`thanks @${SELF.phone}!`);

  h.picker.canned = { headline: "", keys: [] };
  assert.equal(await h.pingTick(), 0);
  assert.equal(h.gateway.sends.length, 0);
  assert.equal(h.picker.calls.length, 1);
  assert.equal(await pending(), 0);

  assert.equal(await h.pingTick(), 0);
  assert.equal(h.picker.calls.length, 1);
});

test("the hourly ceiling holds, and is spent before the model call", async () => {
  await seedAccount();
  const over = PING_PER_HOUR.limit + 2;
  for (let i = 0; i < over; i++) await say(`@${SELF.phone} item ${i}`, `m${i}`);
  assert.equal(await queued(), over);

  h.picker.echo = true;
  assert.equal(await h.pingTick(), PING_PER_HOUR.limit);
  assert.equal(h.gateway.sends.length, PING_PER_HOUR.limit);
  // The suppressed ones cost nothing: no model call was made for them.
  assert.equal(h.picker.calls.length, PING_PER_HOUR.limit);
  // And they are not left to fire an hour later — they are a delay, not a loss.
  assert.equal(await pending(), 0);
});

test("a suppressed mention still reaches the user in the daily message", async () => {
  const { userId, groupId } = await seedAccount();
  const over = PING_PER_HOUR.limit + 1;
  for (let i = 0; i < over; i++) await say(`@${SELF.phone} item ${i}`, `m${i}`);

  h.picker.echo = true;
  assert.equal(await h.pingTick(), PING_PER_HOUR.limit);
  assert.equal(h.gateway.sends.length, PING_PER_HOUR.limit);
  h.gateway.sends = [];

  // The last mention got no ping. The day's message carries it anyway.
  const { rows } = await h.pool.query(
    `SELECT id FROM messages ORDER BY sent_at DESC, external_id DESC LIMIT 1`,
  );
  const summaryId = await h.seedSummary(userId, groupId, {
    action_items: [
      {
        text: "Approve the last item",
        source_message_ids: [rows[0].id],
        owner: null,
        due_at: null,
        confidence: 1,
      },
    ],
  });
  h.picker.echo = false;
  h.picker.canned = { headline: "One thing needs you.", keys: [`${summaryId}|action_items|0`] };

  assert.equal(await h.digestTick(), 1);
  assert.equal(await h.digestSend(), 1);
  assert.equal(h.gateway.sends.length, 1);
  assert.ok(h.gateway.sends[0].text.includes("Approve the last item"), h.gateway.sends[0].text);
});

test("no ping while the Account is paused or disconnected — the mention waits", async () => {
  const { userId, sessionId } = await seedAccount();
  await say(`@${SELF.phone} can you approve this`);
  h.picker.echo = true;

  await h.pool.query(`UPDATE users SET paused = true WHERE id = $1`, [userId]);
  assert.equal(await h.pingTick(), 0);
  assert.equal(h.gateway.sends.length, 0);
  assert.equal(await pending(), 1);

  await h.pool.query(`UPDATE users SET paused = false WHERE id = $1`, [userId]);
  await h.pool.query(`UPDATE whatsapp_sessions SET status = 'disconnected' WHERE id = $1`, [
    sessionId,
  ]);
  assert.equal(await h.pingTick(), 0);
  assert.equal(await pending(), 1);
  // Nothing was judged while it could not be sent, so nothing was spent either.
  assert.equal(h.picker.calls.length, 0);

  await h.pool.query(`UPDATE whatsapp_sessions SET status = 'connected' WHERE id = $1`, [sessionId]);
  assert.equal(await h.pingTick(), 1);
});

test("an Account whose identity is unknown gets no pings, and its daily message still lands", async () => {
  const userId = await h.seedUser("tok");
  const sessionId = await h.seedSession(userId, "sess-1");
  const groupId = await h.seedGroup(sessionId, "group-1@g.us");

  await say(`@${SELF.phone} can you approve this`);
  assert.equal(await queued(), 0);
  h.picker.echo = true;
  assert.equal(await h.pingTick(), 0);

  h.picker.echo = false;
  const summaryId = await h.seedSummary(userId, groupId, {
    action_items: [
      {
        text: "Approve the order",
        source_message_ids: ["m1"],
        owner: null,
        due_at: null,
        confidence: 1,
      },
    ],
  });
  h.picker.canned = { headline: "One thing needs you.", keys: [`${summaryId}|action_items|0`] };
  assert.equal(await h.digestTick(), 1);
  assert.equal(await h.digestSend(), 1);
  assert.equal(h.gateway.sends.length, 1);
});

test("a queued ping leaves with its message at raw expiry, with no second sweep", async () => {
  await seedAccount();
  await say(`@${SELF.phone} can you approve this`);
  assert.equal(await queued(), 1);

  await h.pool.query(`UPDATE messages SET expires_at = now() - interval '1 second'`);
  await purgeExpired(h.pool);

  assert.equal(await queued(), 0);
});
