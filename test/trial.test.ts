import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, type Harness } from "./helpers.ts";
import { ATTESTATION_VERSION } from "../src/subscriptions.ts";
import { PLANS, TRIAL_DAYS } from "../src/billing.ts";

// Ticket 25: the 14-day Trial (spec §96-99, §229-234). Whole-system seam: the
// Trial is granted by the gateway's 'connected' event, spends itself through the
// same plan caps every other gate reads, and is visible in /v1/usage.
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

// Pair a session for `token` on `number` and report it connected.
async function pair(token: string, extId: string, number: string): Promise<string> {
  const userId = await h.seedUser(token);
  const sessionId = await h.seedSession(userId, extId);
  h.gateway.numbers[extId] = number;
  assert.equal(await h.postWebhook({ kind: "status", session: extId, status: "connected" }), 202);
  return sessionId;
}

test("pairing grants a 14-day Trial with Pro's caps, visible in usage", async () => {
  const sessionId = await pair("t1", "sess-t1", "60111111111");

  const res = await h.api("t1", "GET", "/v1/usage");
  const body = res.body as Record<string, any>;
  assert.equal(body.plan, "pro");
  assert.deepEqual(body.limits, PLANS.pro);
  assert.equal(body.trial.days_remaining, TRIAL_DAYS);

  // Pro's caps are real, not decorative: Free stops at 3 enabled Groups.
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) ids.push(await h.seedGroup(sessionId, `tg${i}@g.us`, false));
  for (const id of ids) {
    const r = await h.api("t1", "POST", `/v1/groups/${id}/enable`, {
      attestation_version: ATTESTATION_VERSION,
    });
    assert.equal(r.status, 200);
  }
});

test("the Trial is granted once per WhatsApp number, not once per Account", async () => {
  await pair("t2", "sess-t2", "60222222222");
  await pair("t3", "sess-t3", "60222222222"); // same number, fresh Account

  assert.equal(((await h.api("t2", "GET", "/v1/usage")).body as any).plan, "pro");
  const second = (await h.api("t3", "GET", "/v1/usage")).body as any;
  assert.equal(second.plan, "free");
  assert.equal(second.trial, null);
});

test("reconnecting does not extend or re-grant the Trial", async () => {
  await pair("t4", "sess-t4", "60444444444");
  const first = ((await h.api("t4", "GET", "/v1/usage")).body as any).trial.ends_at;

  await h.postWebhook({ kind: "status", session: "sess-t4", status: "disconnected" });
  await h.postWebhook({ kind: "status", session: "sess-t4", status: "connected" });

  const again = ((await h.api("t4", "GET", "/v1/usage")).body as any).trial.ends_at;
  assert.equal(again, first);
  const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM trials`);
  assert.equal(rows[0].n, 1);
});

test("an expired Trial falls back to Free's caps rather than ending access", async () => {
  const sessionId = await pair("t5", "sess-t5", "60555555555");
  await h.pool.query(`UPDATE trials SET started_at = now() - interval '15 days',
                                        ends_at = now() - interval '1 day'`);

  const body = (await h.api("t5", "GET", "/v1/usage")).body as any;
  assert.equal(body.plan, "free");
  assert.deepEqual(body.limits, PLANS.free);
  assert.equal(body.trial, null);

  // Access degrades, it does not end: the Account still works up to Free's cap.
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) ids.push(await h.seedGroup(sessionId, `eg${i}@g.us`, false));
  const enable = (id: string) =>
    h.api("t5", "POST", `/v1/groups/${id}/enable`, { attestation_version: ATTESTATION_VERSION });
  for (let i = 0; i < PLANS.free.max_groups; i++) assert.equal((await enable(ids[i])).status, 200);
  assert.equal((await enable(ids[PLANS.free.max_groups])).status, 403);
});
