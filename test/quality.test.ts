import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { OPERATOR_SECRET, makeHarness, type Harness } from "./helpers.ts";
import { MALAY_QUALITY_OWNER } from "../src/quality.ts";

// Ticket 16 (spec §54-55): weekly quality operations. Whole-system seam:
// operator-authenticated review queue and review records over real Postgres.

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

function op(
  method: string,
  path: string,
  body?: unknown,
  secret = OPERATOR_SECRET,
): Promise<Response> {
  return fetch(`${h.baseUrl}${path}`, {
    method,
    headers: {
      "x-walao-operator-secret": secret,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function seedSummary(userId: string, groupId: string, language: string): Promise<string> {
  const { rows } = await h.pool.query(
    `INSERT INTO summaries
       (user_id, group_id, language, window_start, window_end, payload,
        model, prompt_version, input_tokens, output_tokens, duration_ms)
     VALUES ($1, $2, $3, now() - interval '1 hour', now(), '{}', 't', 't', 0, 0, 0)
     RETURNING id`,
    [userId, groupId, language],
  );
  return rows[0].id;
}

test("review endpoints require the operator secret", async () => {
  assert.equal((await op("GET", "/admin/review/queue", undefined, "wrong")).status, 401);
  assert.equal(
    (await op("POST", "/admin/review", { kind: "beta" }, "wrong")).status,
    401,
  );
});

test("Malay lane (§54): unreviewed ms summaries queue under the named owner; a review clears them", async () => {
  const userId = await h.seedUser("q1");
  const sessionId = await h.seedSession(userId, "sess-q1");
  const groupId = await h.seedGroup(sessionId, "g1@g.us");
  const msId = await seedSummary(userId, groupId, "ms");
  const enId = await seedSummary(userId, groupId, "en");

  const queue = (await (await op("GET", "/admin/review/queue")).json()) as any;
  assert.equal(queue.malay.quality_owner, MALAY_QUALITY_OWNER);
  assert.deepEqual(
    queue.malay.pending.map((p: any) => p.summary_id),
    [msId],
  );

  // Reviewing a non-Malay summary through the Malay lane is refused.
  const wrongLane = await op("POST", "/admin/review", {
    kind: "malay",
    summary_id: enId,
    reviewer: "product-owner",
    verdict: { ok: true },
  });
  assert.equal(wrongLane.status, 404);

  // A verdict without pass/fail is not a review.
  const noVerdict = await op("POST", "/admin/review", {
    kind: "malay",
    summary_id: msId,
    reviewer: "product-owner",
    verdict: { notes: "looks fine" },
  });
  assert.equal(noVerdict.status, 400);

  const ok = await op("POST", "/admin/review", {
    kind: "malay",
    summary_id: msId,
    reviewer: "product-owner",
    verdict: { ok: true, notes: "terjemahan tepat" },
  });
  assert.equal(ok.status, 201);

  const after = (await (await op("GET", "/admin/review/queue")).json()) as any;
  assert.deepEqual(after.malay.pending, []);
});

test("beta lane (§55): weekly stats visible, counts required, reviewed flag flips", async () => {
  const userId = await h.seedUser("q2");
  const sessionId = await h.seedSession(userId, "sess-q2");
  const groupId = await h.seedGroup(sessionId, "g1@g.us");
  await seedSummary(userId, groupId, "en");
  await h.api("q2", "POST", "/v1/pause"); // creates a privacy_audit event

  const queue = (await (await op("GET", "/admin/review/queue")).json()) as any;
  assert.equal(queue.beta.summaries_7d, 1);
  assert.equal(queue.beta.privacy_events_7d, 1);
  assert.equal(queue.beta.reviewed, false);

  // Missing counts → not a review.
  const partial = await op("POST", "/admin/review", {
    kind: "beta",
    reviewer: "product-owner",
    verdict: { accuracy_issues: 0 },
  });
  assert.equal(partial.status, 400);

  const full = await op("POST", "/admin/review", {
    kind: "beta",
    reviewer: "product-owner",
    verdict: { accuracy_issues: 0, omissions: 1, privacy_events: 1, notes: "one late brief" },
  });
  assert.equal(full.status, 201);

  const after = (await (await op("GET", "/admin/review/queue")).json()) as any;
  assert.equal(after.beta.reviewed, true);
});
