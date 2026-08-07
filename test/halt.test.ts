import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  OPERATOR_SECRET,
  buildEvent,
  countIngestEvents,
  makeHarness,
  type Harness,
} from "./helpers.ts";
import { ONBOARDING_DISCLOSURE } from "../src/connections.ts";
import { ATTESTATION_TEXTS } from "../src/attestations.ts";

const TIER1_VERSION = ATTESTATION_TEXTS.tier1_outbound.version;

// Ticket 14 (spec §49): product-wide gateway halt switch. Whole-system seam:
// real ingress + API + delivery drain, sends captured by the fake gateway.

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

const opPost = (path: string, secret: string) => h.op("POST", path, undefined, secret);

const PAYLOAD = {
  highlights: [{ text: "big news", sources: [] }],
  decisions: [],
  action_items: [],
  dates: [],
  open_questions: [],
  memory_candidates: [],
};

async function seedPendingSummary(userId: string, groupId: string, windowEnd: Date): Promise<void> {
  await h.pool.query(
    `INSERT INTO summaries
       (user_id, group_id, language, window_start, window_end, payload,
        model, prompt_version, input_tokens, output_tokens, duration_ms)
     VALUES ($1, $2, 'en', $3, $4, $5, 't', 't', 0, 0, 0)`,
    [userId, groupId, new Date(windowEnd.getTime() - 3600_000), windowEnd, JSON.stringify(PAYLOAD)],
  );
}

test("halt endpoint requires the operator secret", async () => {
  assert.equal((await opPost("/admin/halt", "wrong-secret")).status, 401);
  assert.equal((await opPost("/admin/halt", "")).status, 401);

  const userId = await h.seedUser("op0");
  await h.seedSession(userId, "sess-op0");
  const res = await h.api("op0", "GET", "/v1/connections");
  assert.equal((res.body as { halted: boolean }).halted, false); // state untouched
});

test("the console reads the halt state without flipping it (§58)", async () => {
  const read = async () => {
    const res = await h.op("GET", "/admin/halt", undefined, OPERATOR_SECRET);
    assert.equal(res.status, 200);
    return (await res.json()) as { halted: boolean };
  };
  assert.equal((await read()).halted, false);
  await opPost("/admin/halt", OPERATOR_SECRET);
  assert.equal((await read()).halted, true);
  assert.equal((await h.op("GET", "/admin/halt", undefined, "wrong")).status, 401);
});

test("halt stops all gateway activity: webhooks refused, sends and pairing blocked", async () => {
  const userId = await h.seedUser("op1");
  const sessionId = await h.seedSession(userId, "sess-op1");
  const groupId = await h.seedGroup(sessionId, "group-1@g.us");
  await seedPendingSummary(userId, groupId, new Date());
  await h.api("op1", "POST", "/v1/tier1", { authorization_version: TIER1_VERSION });

  assert.equal((await opPost("/admin/halt", OPERATOR_SECRET)).status, 200);

  // New webhook events are refused outright, nothing persisted.
  assert.equal(await h.postWebhook(buildEvent({ session: "sess-op1" })), 503);
  assert.equal(await countIngestEvents(h.pool), 0);

  // Pending summaries do not go out.
  assert.equal(await h.deliver(), 0);
  assert.equal(h.gateway.sends.length, 0);

  // Tier 1 outbound is blocked.
  const out = await h.api("op1", "POST", "/v1/outbound", { recipient: "b@s.whatsapp.net", text: "x" });
  assert.equal(out.status, 503);
  assert.equal(h.gateway.recipientSends.length, 0);

  // Pairing is gateway activity too.
  const pair = await h.api("op1", "POST", "/v1/connections", {
    disclosure_version: ONBOARDING_DISCLOSURE.version,
  });
  assert.equal(pair.status, 503);

  // Halt state is visible on the connection-health surface.
  const conns = await h.api("op1", "GET", "/v1/connections");
  assert.equal((conns.body as { halted: boolean }).halted, true);
});

test("summary window overlapping a halt drains after resume, and the gap is recorded", async () => {
  const userId = await h.seedUser("op2");
  const sessionId = await h.seedSession(userId, "sess-op2");
  const groupId = await h.seedGroup(sessionId, "group-2@g.us");

  await opPost("/admin/halt", OPERATOR_SECRET);
  await opPost("/admin/resume", OPERATOR_SECRET);

  // Window [now-30m, now+30m] provably spans the halt moment → overlaps the
  // closed 'halted' coverage gap. (windowEnd = now+1h put window_start at the
  // seed instant, racing the gap's ended_at by sub-millisecond margins.)
  await seedPendingSummary(userId, groupId, new Date(Date.now() + 1800_000));
  assert.equal(await h.deliver(), 1);
  // Ticket 6: the drain no longer sends per Summary, so the lost window shows
  // up as the coverage gap it is rather than as a warning line in a message.
  assert.equal(h.gateway.sends.length, 0);
  const { rows } = await h.pool.query(
    `SELECT reason FROM coverage_gaps WHERE session_id = $1`,
    [sessionId],
  );
  assert.deepEqual(
    rows.map((r) => r.reason),
    ["halted"],
  );
});

test("resume restores normal operation without duplicate delivery", async () => {
  const userId = await h.seedUser("op3");
  const sessionId = await h.seedSession(userId, "sess-op3");
  const groupId = await h.seedGroup(sessionId, "group-3@g.us");
  // Window entirely before the halt → no gap overlap, no incomplete flag.
  await seedPendingSummary(userId, groupId, new Date(Date.now() - 86400_000));

  await opPost("/admin/halt", OPERATOR_SECRET);
  assert.equal(await h.deliver(), 0);
  assert.equal((await opPost("/admin/resume", OPERATOR_SECRET)).status, 200);

  // Webhooks accepted again.
  assert.equal(await h.postWebhook(buildEvent({ session: "sess-op3", chatId: "group-3@g.us" })), 202);
  assert.equal(await countIngestEvents(h.pool), 1);

  // The waiting summary is processed exactly once, and sends nothing itself.
  assert.equal(await h.deliver(), 1);
  assert.equal(h.gateway.sends.length, 0);
  assert.equal(await h.deliver(), 0);

  const conns = await h.api("op3", "GET", "/v1/connections");
  assert.equal((conns.body as { halted: boolean }).halted, false);
});
