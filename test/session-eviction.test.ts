import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, type Harness } from "./helpers.ts";
import { evictIdleSessions, ONBOARDING_DISCLOSURE } from "../src/connections.ts";
import { DATA_PROCESSING_TERMS as TERMS } from "../src/attestations.ts";

// Ticket 20 (spec §13-14, §242-245, ADR-0001): a Session with no enabled Group
// and no login for 14 days is retired to re_pair_required, opens a Coverage Gap,
// and stays recoverable — the Account pairs again. Time moves by backdating
// seeded rows, the pattern the spec's testing section names.

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

const age = (sessionId: string, days: number) =>
  h.pool.query(`UPDATE whatsapp_sessions SET created_at = now() - $2::interval WHERE id = $1`, [
    sessionId,
    `${days} days`,
  ]);

const statusOf = (sessionId: string) =>
  h.pool
    .query(`SELECT status FROM whatsapp_sessions WHERE id = $1`, [sessionId])
    .then((r) => r.rows[0].status as string);

const openGaps = (sessionId: string) =>
  h.pool
    .query(`SELECT reason FROM coverage_gaps WHERE session_id = $1 AND ended_at IS NULL`, [
      sessionId,
    ])
    .then((r) => r.rows.map((x) => x.reason as string));

test("an idle Session is retired, opens a Coverage Gap, and says so on /v1/status", async () => {
  const token = "tok-idle";
  const userId = await h.seedUser(token);
  const sessionId = await h.seedSession(userId, "sess-idle");
  await h.pool.query(`UPDATE whatsapp_sessions SET status = 'connected' WHERE id = $1`, [
    sessionId,
  ]);
  await age(sessionId, 20);

  assert.equal(await evictIdleSessions(h.pool), 1);
  assert.equal(await statusOf(sessionId), "re_pair_required");
  assert.deepEqual(await openGaps(sessionId), ["re_pair_required"]);

  const status = (await h.api(token, "GET", "/v1/status")).body as {
    processing: boolean;
    block: { reason: string } | null;
    session: { status: string };
    coverage_gap: { reason: string } | null;
  };
  assert.equal(status.processing, false);
  assert.equal(status.block?.reason, "unpaired"); // pairing again is the fix
  assert.equal(status.session.status, "re_pair_required");
  assert.equal(status.coverage_gap?.reason, "re_pair_required");
});

test("a Session with an enabled Group is never evicted, however old", async () => {
  const userId = await h.seedUser("tok-active");
  const sessionId = await h.seedSession(userId, "sess-active");
  await h.seedGroup(sessionId, "group-active@g.us", true);
  await age(sessionId, 90);

  assert.equal(await evictIdleSessions(h.pool), 0);
  assert.equal(await statusOf(sessionId), "connected"); // seedSession's default
  assert.deepEqual(await openGaps(sessionId), []);
});

test("a recent login keeps an idle Session alive", async () => {
  await h.api("", "POST", "/v1/signup", {
    email: "merchant@example.com",
    terms_version: TERMS.version,
  });
  const verified = await h.api("", "POST", "/v1/verify", {
    email: "merchant@example.com",
    code: h.codes[0].code,
  });
  const { user_id } = verified.body as { user_id: string };

  const sessionId = await h.seedSession(user_id, "sess-loggedin");
  await age(sessionId, 20);

  assert.equal(await evictIdleSessions(h.pool), 0);
  assert.equal(await statusOf(sessionId), "connected"); // seedSession's default

  // Backdate the login too and the same Session goes.
  await h.pool.query(`UPDATE users SET last_login_at = now() - interval '20 days' WHERE id = $1`, [
    user_id,
  ]);
  assert.equal(await evictIdleSessions(h.pool), 1);
});

test("eviction is idempotent — a second pass evicts nothing and opens no second gap", async () => {
  const userId = await h.seedUser("tok-twice");
  const sessionId = await h.seedSession(userId, "sess-twice");
  await age(sessionId, 20);

  assert.equal(await evictIdleSessions(h.pool), 1);
  assert.equal(await evictIdleSessions(h.pool), 0);
  assert.deepEqual(await openGaps(sessionId), ["re_pair_required"]);
});

test("an evicted Account can pair again and its status follows the new Session", async () => {
  const token = "tok-repair";
  const userId = await h.seedUser(token);
  const evictedId = await h.seedSession(userId, "sess-evicted");
  await age(evictedId, 20);
  await evictIdleSessions(h.pool);

  const paired = await h.api(token, "POST", "/v1/connections", {
    disclosure_version: ONBOARDING_DISCLOSURE.version,
  });
  assert.equal(paired.status, 201);

  const status = (await h.api(token, "GET", "/v1/status")).body as {
    session: { status: string };
    coverage_gap: { reason: string } | null;
  };
  assert.equal(status.session.status, "pending");
  assert.equal(status.coverage_gap, null); // the retired Session's gap is history, not now
  // The retired row and its gap stay as the record of the window that was lost.
  assert.deepEqual(await openGaps(evictedId), ["re_pair_required"]);
});
