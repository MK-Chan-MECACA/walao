import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, type Harness } from "./helpers.ts";
import { DATA_PROCESSING_TERMS as TERMS } from "../src/attestations.ts";

// Ticket 18 (spec §1-3, §199-203): Account identity by verified email.
// Whole-system seam — real HTTP, real Postgres, the mail seam captured in
// h.codes. Nothing here reaches into the module.

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

const post = (path: string, body: unknown) => h.api("", "POST", path, body);
const lastCode = () => h.codes[h.codes.length - 1].code;

test("signup mails a code; verifying it issues a working credential", async () => {
  const signup = await post("/v1/signup", {
    email: "merchant@example.com",
    terms_version: TERMS.version,
  });
  assert.equal(signup.status, 202);
  assert.equal(h.codes.length, 1);
  assert.equal(h.codes[0].email, "merchant@example.com");

  const verified = await post("/v1/verify", {
    email: "merchant@example.com",
    code: lastCode(),
  });
  assert.equal(verified.status, 200);
  const { token } = verified.body as { token: string };

  // Spec §3: the Account is usable with no WhatsApp Session paired.
  const status = await h.api(token, "GET", "/v1/status");
  assert.equal(status.status, 200);
  assert.equal((status.body as { block: { reason: string } }).block.reason, "unpaired");

  const { rows } = await h.pool.query(
    `SELECT email_verified_at, login_code_sha256 FROM users WHERE email = 'merchant@example.com'`,
  );
  assert.ok(rows[0].email_verified_at);
  assert.equal(rows[0].login_code_sha256, null); // code consumed
});

test("login rotates the credential; the previous token stops working", async () => {
  await post("/v1/signup", { email: "a@example.com", terms_version: TERMS.version });
  const first = (await post("/v1/verify", { email: "a@example.com", code: lastCode() }))
    .body as { token: string };

  assert.equal((await post("/v1/login", { email: "a@example.com" })).status, 202);
  const second = (await post("/v1/verify", { email: "a@example.com", code: lastCode() }))
    .body as { token: string };

  assert.notEqual(second.token, first.token);
  assert.equal((await h.api(second.token, "GET", "/v1/status")).status, 200);
  assert.equal((await h.api(first.token, "GET", "/v1/status")).status, 401);
});

test("an unknown address is not revealed and creates nothing", async () => {
  const res = await post("/v1/login", { email: "nobody@example.com" });
  assert.equal(res.status, 202); // same answer as a known address
  assert.deepEqual(res.body, { ok: true });
  assert.equal(h.codes.length, 0);

  const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM users`);
  assert.equal(rows[0].n, 0);
});

test("a wrong or expired code issues nothing", async () => {
  await post("/v1/signup", { email: "b@example.com", terms_version: TERMS.version });

  const wrong = await post("/v1/verify", { email: "b@example.com", code: "ZZZZZZZZ" });
  assert.equal(wrong.status, 400);
  assert.deepEqual(wrong.body, { error: "invalid_code" });

  const code = lastCode();
  await h.pool.query(`UPDATE users SET login_code_expires_at = now() - interval '1 minute'`);
  assert.equal((await post("/v1/verify", { email: "b@example.com", code })).status, 400);

  const { rows } = await h.pool.query(
    `SELECT api_token_sha256, email_verified_at FROM users WHERE email = 'b@example.com'`,
  );
  assert.equal(rows[0].api_token_sha256, null);
  assert.equal(rows[0].email_verified_at, null);
});

test("addresses are one Account regardless of case or padding", async () => {
  await post("/v1/signup", { email: "  Merchant@Example.COM ", terms_version: TERMS.version });
  await post("/v1/signup", { email: "merchant@example.com", terms_version: TERMS.version });

  const { rows } = await h.pool.query(`SELECT email FROM users`);
  assert.deepEqual(rows, [{ email: "merchant@example.com" }]);

  // The second code belongs to the same Account and still works.
  const verified = await post("/v1/verify", { email: "MERCHANT@example.com", code: lastCode() });
  assert.equal(verified.status, 200);
});

test("a malformed address is rejected before any row is written", async () => {
  for (const email of ["not-an-email", "", "  ", null, 42, `${"x".repeat(250)}@example.com`]) {
    const res = await post("/v1/signup", { email, terms_version: TERMS.version });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(email)}`);
    assert.deepEqual(res.body, { error: "invalid_email" });
  }
  const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM users`);
  assert.equal(rows[0].n, 0);
  assert.equal(h.codes.length, 0);
});
