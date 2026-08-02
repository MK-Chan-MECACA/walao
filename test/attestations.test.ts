import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, type Harness } from "./helpers.ts";
import { DATA_PROCESSING_TERMS as TERMS } from "../src/attestations.ts";
import { ONBOARDING_DISCLOSURE } from "../src/connections.ts";
import { ATTESTATION_VERSION } from "../src/subscriptions.ts";

// Ticket 19 (spec §6, §8, §20-21, §77, §205-210): every affirmation is stored
// with the version of the wording that was shown, in one trail the Account can
// read back. Whole-system seam — real HTTP, real Postgres.

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

type Row = { kind: string; version: string | null; group_id: string | null; created_at: string };
// id and created_at vary per run; the assertions are about kind/version/scope.
async function trail(token: string): Promise<Omit<Row, "created_at">[]> {
  const body = (await h.api(token, "GET", "/v1/attestations")).body as { attestations: Row[] };
  return body.attestations.map(({ kind, version, group_id, created_at }) => {
    assert.ok(!Number.isNaN(Date.parse(created_at)));
    return { kind, version, group_id };
  });
}

test("the terms are readable without a credential and name the region and provider", async () => {
  const res = await h.api("", "GET", "/v1/terms");
  assert.equal(res.status, 200);
  const body = res.body as { version: string; text: string };
  assert.equal(body.version, TERMS.version);
  assert.match(body.text, /Singapore/);
  assert.match(body.text, /Anthropic/);
});

test("signing up stores the terms Attestation with the version that was shown", async () => {
  const res = await h.api("", "POST", "/v1/signup", {
    email: "merchant@example.com",
    terms_version: TERMS.version,
  });
  assert.equal(res.status, 202);

  const { rows } = await h.pool.query(
    `SELECT kind, version, group_id FROM attestations`,
  );
  assert.deepEqual(rows, [
    { kind: "data_processing_terms", version: TERMS.version, group_id: null },
  ]);
});

test("signing up without the current terms version creates nothing", async () => {
  for (const terms_version of [undefined, "", "1999-01-01"]) {
    const res = await h.api("", "POST", "/v1/signup", {
      email: "merchant@example.com",
      terms_version,
    });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(terms_version)}`);
    assert.deepEqual(res.body, { error: "terms_required" });
  }
  const { rows } = await h.pool.query(
    `SELECT count(*)::int AS users, (SELECT count(*)::int FROM attestations) AS atts FROM users`,
  );
  assert.deepEqual(rows[0], { users: 0, atts: 0 });
  assert.equal(h.codes.length, 0);
});

test("pairing, enabling a Group and Tier 1 each leave their own Attestation", async () => {
  const token = "tok";
  const userId = await h.seedUser(token);

  const paired = await h.api(token, "POST", "/v1/connections", {
    disclosure_version: ONBOARDING_DISCLOSURE.version,
  });
  assert.equal(paired.status, 201);

  const sessionId = await h.seedSession(userId, "sess-att");
  const groupId = await h.seedGroup(sessionId, "group-att@g.us", false);
  assert.equal(
    (await h.api(token, "POST", `/v1/groups/${groupId}/enable`, {
      attestation_version: ATTESTATION_VERSION,
    })).status,
    200,
  );

  assert.equal(
    (await h.api(token, "POST", "/v1/tier1", { authorization_version: "2026-07-31" })).status,
    200,
  );

  assert.deepEqual(await trail(token), [
    { kind: "ban_risk", version: ONBOARDING_DISCLOSURE.version, group_id: null },
    { kind: "group_responsibility", version: ATTESTATION_VERSION, group_id: groupId },
    { kind: "tier1_outbound", version: "2026-07-31", group_id: null },
  ]);

  // Tier 1 still works off the fast lookup now that the version column is gone.
  const { rows } = await h.pool.query(`SELECT tier1_enabled_at FROM users WHERE id = $1`, [
    userId,
  ]);
  assert.ok(rows[0].tier1_enabled_at);
});

test("a refused disclosure pairs nothing and records nothing", async () => {
  const token = "tok";
  await h.seedUser(token);
  const res = await h.api(token, "POST", "/v1/connections", {
    disclosure_version: "1999-01-01",
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await trail(token), []);
  const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM whatsapp_sessions`);
  assert.equal(rows[0].n, 0);
});

test("one Account's trail is invisible to another", async () => {
  const aliceId = await h.seedUser("tok-alice");
  await h.seedUser("tok-bob");
  const sessionId = await h.seedSession(aliceId, "sess-alice");
  const groupId = await h.seedGroup(sessionId, "group-alice@g.us", false);
  await h.api("tok-alice", "POST", `/v1/groups/${groupId}/enable`, {
    attestation_version: ATTESTATION_VERSION,
  });

  assert.equal((await trail("tok-alice")).length, 1);
  assert.deepEqual(await trail("tok-bob"), []);
});
