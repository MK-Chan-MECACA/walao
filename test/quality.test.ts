import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, type Harness } from "./helpers.ts";
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

const op = (method: string, path: string, body?: unknown, secret?: string) =>
  h.op(method, path, body, secret);

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
  const msId = await h.seedSummary(userId, groupId, {}, { language: "ms" });
  const enId = await h.seedSummary(userId, groupId);

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

  // A malformed summary id is a client error, not a Postgres cast 500.
  const badId = await op("POST", "/admin/review", {
    kind: "malay",
    summary_id: "abc",
    reviewer: "product-owner",
    verdict: { ok: true },
  });
  assert.equal(badId.status, 400);

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

  // A resubmit corrects the review in place — still one row per summary.
  const redo = await op("POST", "/admin/review", {
    kind: "malay",
    summary_id: msId,
    reviewer: "product-owner",
    verdict: { ok: false },
  });
  assert.equal(redo.status, 201);
  const { rows } = await h.pool.query(
    `SELECT verdict FROM quality_reviews WHERE summary_id = $1`,
    [msId],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].verdict.ok, false);

  // Quality history survives summary (and thus account) deletion.
  await h.pool.query(`DELETE FROM summaries WHERE id = $1`, [msId]);
  const kept = await h.pool.query(`SELECT summary_id FROM quality_reviews WHERE kind = 'malay'`);
  assert.equal(kept.rows.length, 1);
  assert.equal(kept.rows[0].summary_id, null);
});

test("beta lane (§55): weekly stats visible, counts required, reviewed flag flips", async () => {
  const userId = await h.seedUser("q2");
  const sessionId = await h.seedSession(userId, "sess-q2");
  const groupId = await h.seedGroup(sessionId, "g1@g.us");
  await h.seedSummary(userId, groupId);
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

  // Counts are tallies: negative or fractional numbers are not a review.
  const nonsense = await op("POST", "/admin/review", {
    kind: "beta",
    reviewer: "product-owner",
    verdict: { accuracy_issues: -3, omissions: 0.5, privacy_events: 0 },
  });
  assert.equal(nonsense.status, 400);

  const full = await op("POST", "/admin/review", {
    kind: "beta",
    reviewer: "product-owner",
    verdict: { accuracy_issues: 0, omissions: 1, privacy_events: 1, notes: "one late brief" },
  });
  assert.equal(full.status, 201);

  const after = (await (await op("GET", "/admin/review/queue")).json()) as any;
  assert.equal(after.beta.reviewed, true);
});
