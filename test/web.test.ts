import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { makeHarness, OPERATOR_SECRET, type Harness } from "./helpers.ts";
import { DATA_PROCESSING_TERMS as TERMS } from "../src/attestations.ts";
import { ATTESTATION_VERSION as VERSION } from "../src/subscriptions.ts";
import { purgeExpired } from "../src/retention.ts";

// Ticket 29 (app spec §1-5, §20, §41, §54-55): the backend the web surface
// needs before a line of HTML exists — cookie sessions, a real logout, static
// serving with a traversal guard, Summary citations, and an Operator session.
// Whole-system seam throughout: real HTTP, real Postgres, no module reached into.

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

// node:http rather than fetch: these tests need to control the Host header and
// to send a path with percent-encoding that a URL parser would normalise away.
type RawResponse = { status: number; headers: http.IncomingHttpHeaders; text: string; body: any };

function raw(
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<RawResponse> {
  const url = new URL(h.baseUrl);
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        method,
        path,
        headers: {
          ...(payload !== undefined ? { "content-type": "application/json" } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: any = null;
          try {
            body = JSON.parse(text);
          } catch {
            /* not JSON — `text` is the assertion surface */
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, body });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function setCookie(res: RawResponse): string {
  const raw = res.headers["set-cookie"];
  assert.ok(raw && raw.length === 1, "expected exactly one Set-Cookie");
  return raw[0];
}

// Sign up, verify, and hand back both credentials the app can hold.
async function newSession(
  email: string,
  headers: Record<string, string> = {},
): Promise<{ token: string; cookie: string; setCookie: string }> {
  await raw("POST", "/v1/signup", { body: { email, terms_version: TERMS.version } });
  const code = h.codes[h.codes.length - 1].code;
  const res = await raw("POST", "/v1/verify", { body: { email, code }, headers });
  assert.equal(res.status, 200);
  const header = setCookie(res);
  return { token: res.body.token as string, cookie: header.split(";")[0], setCookie: header };
}

test("verifying sets an httpOnly session cookie, and that cookie alone authenticates", async () => {
  const s = await newSession("cookie@example.com");

  // §3: unreadable to page scripts, and not sent on a cross-site request.
  assert.match(s.setCookie, /^walao_session=[0-9a-f]{64};/);
  assert.match(s.setCookie, /HttpOnly/);
  assert.match(s.setCookie, /SameSite=Lax/);
  assert.match(s.setCookie, /Path=\//);
  assert.equal(s.cookie, `walao_session=${s.token}`);
  // Host is 127.0.0.1 here, so dev over plain HTTP is not locked out.
  assert.doesNotMatch(s.setCookie, /Secure/);

  const withCookie = await raw("GET", "/v1/summaries", { headers: { cookie: s.cookie } });
  assert.equal(withCookie.status, 200);

  const withNothing = await raw("GET", "/v1/summaries");
  assert.equal(withNothing.status, 401);

  const wrongCookie = await raw("GET", "/v1/summaries", {
    headers: { cookie: "walao_session=not-a-token" },
  });
  assert.equal(wrongCookie.status, 401);
});

test("Secure is set for a deployed Host and absent for localhost", async () => {
  const deployed = await newSession("deployed@example.com", { host: "walao.example" });
  assert.match(deployed.setCookie, /; Secure/);

  const local = await newSession("local@example.com", { host: "localhost:3000" });
  assert.doesNotMatch(local.setCookie, /Secure/);
});

test("the bearer header still authenticates with no cookie present", async () => {
  await h.seedUser("bearer-only");
  const res = await raw("GET", "/v1/summaries", {
    headers: { authorization: "Bearer bearer-only" },
  });
  assert.equal(res.status, 200);
});

test("logout clears the cookie and kills the token, not just the browser's copy", async () => {
  const s = await newSession("logout@example.com");

  const out = await raw("POST", "/v1/logout", { headers: { cookie: s.cookie } });
  assert.equal(out.status, 200);
  const cleared = setCookie(out);
  assert.match(cleared, /^walao_session=;/);
  assert.match(cleared, /Max-Age=0/);
  assert.match(cleared, /HttpOnly/);

  // §4: the credential is dead server-side, so a copy of it is worthless.
  assert.equal((await raw("GET", "/v1/summaries", { headers: { cookie: s.cookie } })).status, 401);
  assert.equal(
    (await raw("GET", "/v1/summaries", { headers: { authorization: `Bearer ${s.token}` } })).status,
    401,
  );
  const { rows } = await h.pool.query(
    `SELECT api_token_sha256 FROM users WHERE email = 'logout@example.com'`,
  );
  assert.equal(rows[0].api_token_sha256, null);
});

test("the shell is served from public/, and no path escapes it", async () => {
  const shell = await raw("GET", "/");
  assert.equal(shell.status, 200);
  assert.match(shell.headers["content-type"] as string, /^text\/html/);
  assert.match(shell.text, /WALAO/);

  // Every shape of "climb out of public/": the URL parser flattens the first,
  // the resolve-and-prefix guard stops the encoded ones. All are 404s, and none
  // of them returns a byte of the file they were reaching for.
  for (const path of [
    "/../src/config.ts",
    "/%2e%2e/src/config.ts",
    "/%2e%2e%2f%2e%2e%2fsrc%2fconfig.ts",
    "/..%2fsrc%2fconfig.ts",
    "/%2e%2e/.env",
    "/nope",
  ]) {
    const res = await raw("GET", path);
    assert.equal(res.status, 404, path);
    assert.deepEqual(res.body, { error: "not_found" }, path);
    assert.doesNotMatch(res.text, /WALAO_ENC_KEY|DATABASE_URL/, path);
  }

  // A malformed percent-escape is a 404, not a crash.
  assert.equal((await raw("GET", "/%zz")).status, 404);
});

test("the app's own assets are served with the content types a browser needs", async () => {
  // Ticket 30: the shell is HTML plus two ES modules and one stylesheet. A
  // wrong MIME on a module is a blank page, and nothing else would catch it.
  for (const [path, type] of [
    ["/", /^text\/html/],
    ["/features", /^text\/html/],
    ["/how", /^text\/html/],
    ["/pricing", /^text\/html/],
    ["/security", /^text\/html/],
    ["/signin", /^text\/html/],
    ["/pair", /^text\/html/],
    ["/today", /^text\/html/],
    ["/groups", /^text\/html/],
    ["/lists", /^text\/html/],
    ["/ask", /^text\/html/],
    ["/settings", /^text\/html/],
    ["/ops", /^text\/html/],
    ["/app.css", /^text\/css/],
    ["/site.css", /^text\/css/],
    ["/api.js", /^text\/javascript/],
    ["/layout.js", /^text\/javascript/],
    ["/site.js", /^text\/javascript/],
    ["/og-image.jpg", /^image\/jpeg/],
    ["/apple-touch-icon.png", /^image\/png/],
    ["/favicon.ico", /^image\/x-icon/],
    ["/sitemap.xml", /^application\/xml/],
    // The explainer imports the vendored three.js by absolute path; a wrong
    // MIME here is a module the browser refuses to execute, and the marketing
    // hero silently falls back to nothing.
    ["/explainer.js", /^text\/javascript/],
    ["/vendor/three.module.min.js", /^text\/javascript/],
    ["/vendor/three.core.min.js", /^text\/javascript/],
  ] as const) {
    const res = await raw("GET", path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers["content-type"] as string, type, path);
  }
});

test("only marketing pages are indexable, canonical and shareable", async () => {
  for (const [path, canonical] of [
    ["/", "https://walao.app/"],
    ["/features", "https://walao.app/features"],
    ["/how", "https://walao.app/how"],
    ["/pricing", "https://walao.app/pricing"],
    ["/security", "https://walao.app/security"],
  ] as const) {
    const res = await raw("GET", path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers["x-robots-tag"], undefined, path);
    assert.match(res.text, new RegExp(`<link rel="canonical" href="${canonical}"`), path);
    assert.match(res.text, new RegExp(`<meta property="og:url" content="${canonical}"`), path);
    assert.match(res.text, /<meta property="og:image" content="https:\/\/walao\.app\/og-image\.jpg"/, path);
    assert.match(res.text, /<meta name="twitter:card" content="summary_large_image"/, path);
    assert.equal(res.text.match(/<h1(?:\s|>)/g)?.length, 1, `${path}: one h1`);
  }

  for (const path of ["/signin", "/pair", "/today", "/groups", "/lists", "/ask", "/settings", "/ops"]) {
    assert.equal((await raw("GET", path)).headers["x-robots-tag"], "noindex", path);
  }

  const sitemap = await raw("GET", "/sitemap.xml");
  assert.match(sitemap.text, /<loc>https:\/\/walao\.app\/<\/loc>/);
  assert.doesNotMatch(sitemap.text, /signin|today|ops/);
});

// F1 (audit): the headers that decide what a single injected string is allowed
// to do. They have to be on every response, not only the HTML ones — a JSON
// error body is still something a browser can be talked into rendering.

test("every response carries the security headers, whatever it is answering", async () => {
  const s = await newSession("csp@example.com");

  for (const [method, path, headers] of [
    ["GET", "/", {}],
    ["GET", "/today", {}],
    ["GET", "/app.css", {}],
    ["GET", "/vendor/qrcode.min.js", {}],
    ["GET", "/v1/summaries", { cookie: s.cookie }],
    ["GET", "/v1/nope", { cookie: s.cookie }],
    ["POST", "/webhooks/gateway", {}],
    ["GET", "/admin/review/queue", {}], // a 401 is a response too
  ] as const) {
    const res = await raw(method, path, { headers });
    const where = `${method} ${path}`;
    assert.equal(res.headers["x-content-type-options"], "nosniff", where);
    assert.equal(res.headers["x-frame-options"], "DENY", where);
    assert.equal(res.headers["referrer-policy"], "no-referrer", where);
    assert.match(res.headers["strict-transport-security"] as string, /max-age=\d+/, where);
    const csp = res.headers["content-security-policy"] as string;
    assert.ok(csp, `${where} has a CSP`);
    // Strict because F1+F2 made it possible to be: no inline script, no CDN.
    assert.match(csp, /(^|; )script-src 'self'(;|$)/, where);
    assert.match(csp, /(^|; )frame-ancestors 'none'(;|$)/, where);
    assert.match(csp, /(^|; )object-src 'none'(;|$)/, where);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/, where);
  }
});

test("no page carries an inline script for the CSP to have to allow", async () => {
  for (const path of ["/", "/pair", "/today", "/groups", "/lists", "/ask", "/settings", "/ops"]) {
    const res = await raw("GET", path);
    assert.equal(res.status, 200, path);
    // Every <script> points at a file this origin serves. An inline one would
    // mean script-src 'self' silently stopped the page from working.
    for (const tag of res.text.match(/<script[^>]*>/g) ?? []) {
      assert.match(tag, /\ssrc="\/[^"]+"/, `${path}: ${tag}`);
    }
    // Only tags that fetch count: canonical/og carry absolute walao.app URLs as
    // metadata, and a crawler reading them pulls nothing into the page.
    for (const tag of res.text.match(/<(?:script|link|img|iframe|source)[^>]*>/g) ?? []) {
      if (/rel="canonical"/.test(tag)) continue;
      assert.doesNotMatch(tag, /https?:\/\/(?!127\.0\.0\.1|localhost)/, `${path} loads no CDN`);
    }
  }

  // F2: the QR library is ours now, and it is the real one.
  const lib = await raw("GET", "/vendor/qrcode.min.js");
  assert.equal(lib.status, 200);
  assert.match(lib.headers["content-type"] as string, /^text\/javascript/);
  assert.match(lib.text, /createDataURL/); // what pair.js builds the <img> from

  // F11: the two files a browser and a crawler each ask for unprompted.
  const icon = await raw("GET", "/favicon.svg");
  assert.equal(icon.status, 200);
  assert.match(icon.headers["content-type"] as string, /^image\/svg\+xml/);
  const robots = await raw("GET", "/robots.txt");
  assert.equal(robots.status, 200);
  assert.match(robots.headers["content-type"] as string, /^text\/plain/);
  assert.match(robots.text, /Disallow: \/admin\//);
  assert.match(robots.text, /Disallow: \/v1\//);
});

// F5: a prefix is not a boundary. Latent while no sibling directory shares the
// prefix, so the test makes one — the guard has to hold on its own terms, not
// because of what happens to be next to public/ today.
test("a sibling directory that shares public/'s name prefix is not servable", async () => {
  const sibling = fileURLToPath(new URL("../public-secret/", import.meta.url));
  await mkdir(sibling, { recursive: true });
  await writeFile(`${sibling}marker.txt`, "SIBLING_MARKER");
  try {
    for (const path of [
      "/../public-secret/marker.txt",
      "/%2e%2e/public-secret/marker.txt",
      "/..%2fpublic-secret%2fmarker.txt",
      "/%2e%2e%2fpublic-secret%2fmarker.txt",
    ]) {
      const res = await raw("GET", path);
      assert.equal(res.status, 404, path);
      assert.doesNotMatch(res.text, /SIBLING_MARKER/, path);
    }
  } finally {
    await rm(sibling, { recursive: true, force: true });
  }
});

// F6: the container's liveness probe. Public on purpose, so it must say nothing.
test("/healthz answers without a credential and without telling anyone anything", async () => {
  const res = await raw("GET", "/healthz");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
});

// F3: the Operator cookie used to *be* the permanent secret. Now it is a session
// that can be revoked, expires on its own, and is not the credential in transit.

test("the Operator cookie is a session token, not the operator secret itself", async () => {
  const ok = await raw("POST", "/admin/session", { body: { secret: OPERATOR_SECRET } });
  assert.equal(ok.status, 200);
  const cookie = setCookie(ok).split(";")[0];
  const token = cookie.slice("walao_op=".length);

  // The whole point: a leaked cookie is not the credential.
  assert.notEqual(token, OPERATOR_SECRET);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.ok(!token.includes(OPERATOR_SECRET));

  // It authorises, and it is backed by a row rather than by a string compare.
  assert.equal((await raw("GET", "/admin/review/queue", { headers: { cookie } })).status, 200);
  const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM operator_sessions`);
  assert.equal(rows[0].n, 1);
  // Stored as a hash, like every other credential this app holds.
  const stored = await h.pool.query(`SELECT token_sha256 FROM operator_sessions`);
  assert.notEqual(stored.rows[0].token_sha256, token);

  // A token nobody issued is not a session.
  assert.equal(
    (await raw("GET", "/admin/review/queue", { headers: { cookie: `walao_op=${"0".repeat(64)}` } }))
      .status,
    401,
  );
});

test("signing out ends the Operator session server-side, not just in the browser", async () => {
  const ok = await raw("POST", "/admin/session", { body: { secret: OPERATOR_SECRET } });
  const cookie = setCookie(ok).split(";")[0];
  assert.equal((await raw("GET", "/admin/review/queue", { headers: { cookie } })).status, 200);

  const out = await raw("DELETE", "/admin/session", { headers: { cookie } });
  assert.equal(out.status, 200);
  assert.match(setCookie(out), /^walao_op=;.*Max-Age=0/);

  // The browser's copy is now worthless — which is what "sign out" has to mean.
  assert.equal((await raw("GET", "/admin/review/queue", { headers: { cookie } })).status, 401);
  const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM operator_sessions`);
  assert.equal(rows[0].n, 0);

  // The header path is untouched: scripts and curl still use the secret.
  assert.equal((await h.op("GET", "/admin/review/queue")).status, 200);
});

test("an expired Operator session is refused, and the purge collects it", async () => {
  const ok = await raw("POST", "/admin/session", { body: { secret: OPERATOR_SECRET } });
  const cookie = setCookie(ok).split(";")[0];

  await h.pool.query(`UPDATE operator_sessions SET expires_at = now() - interval '1 minute'`);
  assert.equal((await raw("GET", "/admin/review/queue", { headers: { cookie } })).status, 401);

  await purgeExpired(h.pool);
  const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM operator_sessions`);
  assert.equal(rows[0].n, 0);
});

// F4: nothing throttled anything, and two of these routes send real email.

test("a mailbox cannot be flooded, and the limiter says so in the same words as success", async () => {
  const email = "flood@example.com";
  for (let i = 0; i < 5; i++) {
    const res = await raw("POST", "/v1/signup", { body: { email, terms_version: TERMS.version } });
    assert.equal(res.status, 202, `request ${i + 1} is inside the limit`);
  }
  assert.equal(h.codes.length, 5);

  const over = await raw("POST", "/v1/signup", { body: { email, terms_version: TERMS.version } });
  // Same status and same body as a request that worked: the limiter must not
  // become the oracle the 202-always answer exists to prevent.
  assert.equal(over.status, 202);
  assert.deepEqual(over.body, { ok: true });
  assert.equal(h.codes.length, 5, "no sixth email was sent");

  // Login shares the budget — it is the same act and the same mailbox.
  const viaLogin = await raw("POST", "/v1/login", { body: { email } });
  assert.equal(viaLogin.status, 202);
  assert.equal(h.codes.length, 5);

  // A different address is unaffected: the limit is per mailbox, not global.
  const other = await raw("POST", "/v1/signup", {
    body: { email: "not-flooded@example.com", terms_version: TERMS.version },
  });
  assert.equal(other.status, 202);
  assert.equal(h.codes.length, 6);
});

test("one source cannot mail-bomb many addresses either", async () => {
  // Twenty per hour per source, so the twenty-first address gets nothing even
  // though its own mailbox has never been written to.
  for (let i = 0; i < 20; i++) {
    await raw("POST", "/v1/signup", {
      body: { email: `bomb${i}@example.com`, terms_version: TERMS.version },
    });
  }
  assert.equal(h.codes.length, 20);

  const over = await raw("POST", "/v1/signup", {
    body: { email: "bomb-last@example.com", terms_version: TERMS.version },
  });
  assert.equal(over.status, 202);
  assert.equal(h.codes.length, 20, "the source is out of budget, whoever it asks for");
  const { rows } = await h.pool.query(
    `SELECT count(*)::int AS n FROM users WHERE email = 'bomb-last@example.com'`,
  );
  assert.equal(rows[0].n, 0, "and no row was written for the refused address");
});

test("code guessing is capped, and being capped looks exactly like guessing wrong", async () => {
  const email = "guess@example.com";
  await raw("POST", "/v1/signup", { body: { email, terms_version: TERMS.version } });
  const code = h.codes[h.codes.length - 1].code;

  for (let i = 0; i < 10; i++) {
    const res = await raw("POST", "/v1/verify", { body: { email, code: "WRONG123" } });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "invalid_code" });
  }

  // The eleventh attempt is refused by the limiter — including the right code,
  // which is the point: the attacker cannot tell the two apart, and neither
  // response says anything the other does not.
  const over = await raw("POST", "/v1/verify", { body: { email, code } });
  assert.equal(over.status, 400);
  assert.deepEqual(over.body, { error: "invalid_code" });

  // An unparseable address is rejected on the regex, so it never spends budget
  // and the contract that it answers 400 invalid_email is unchanged.
  const malformed = await raw("POST", "/v1/signup", {
    body: { email: "not-an-email", terms_version: TERMS.version },
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(malformed.body, { error: "invalid_email" });
});

test("a body far larger than any real request is refused instead of buffered", async () => {
  const huge = "x".repeat(1_100_000);

  const signup = await raw("POST", "/v1/signup", { body: { email: `${huge}@example.com` } });
  assert.equal(signup.status, 400);
  assert.deepEqual(signup.body, { error: "bad_json" });

  // The webhook is the one route that reads a raw body, and it refuses before
  // computing an HMAC — which would have to read all of it to say no.
  const hook = await raw("POST", "/webhooks/gateway", {
    headers: { "x-walao-signature": "00" },
    body: { kind: "message", text: huge },
  });
  assert.equal(hook.status, 400);

  // A body just under the cap still works: the guard is a cap, not a new limit
  // on ordinary requests.
  const fine = await raw("POST", "/v1/signup", {
    body: { email: "big-but-fine@example.com", terms_version: TERMS.version, pad: "y".repeat(900_000) },
  });
  assert.equal(fine.status, 202);
});

// F7: a token that never expires is a leak with no deadline.

test("a bearer token expires, and the purge stops the row holding it at all", async () => {
  const s = await newSession("ttl@example.com");
  const { rows } = await h.pool.query(
    `SELECT token_expires_at, token_expires_at > now() + interval '29 days' AS long_enough
     FROM users WHERE email = 'ttl@example.com'`,
  );
  assert.ok(rows[0].token_expires_at, "verifying stamps a deadline on the token it mints");
  assert.equal(rows[0].long_enough, true);

  // Still inside the window: both credentials work.
  assert.equal((await raw("GET", "/v1/summaries", { headers: { cookie: s.cookie } })).status, 200);

  await h.pool.query(
    `UPDATE users SET token_expires_at = now() - interval '1 second' WHERE email = 'ttl@example.com'`,
  );
  assert.equal((await raw("GET", "/v1/summaries", { headers: { cookie: s.cookie } })).status, 401);
  assert.equal(
    (await raw("GET", "/v1/summaries", { headers: { authorization: `Bearer ${s.token}` } })).status,
    401,
  );

  // And the hash goes with it, so the row stops holding a credential.
  await purgeExpired(h.pool);
  const after = await h.pool.query(
    `SELECT api_token_sha256, token_expires_at FROM users WHERE email = 'ttl@example.com'`,
  );
  assert.equal(after.rows[0].api_token_sha256, null);
  assert.equal(after.rows[0].token_expires_at, null);

  // Signing in again is the renewal — there is nothing new for a client to call.
  const fresh = await newSession("ttl@example.com");
  assert.equal(
    (await raw("GET", "/v1/summaries", { headers: { cookie: fresh.cookie } })).status,
    200,
  );
});

test("a Summary's sources are exactly the messages it cites, and only its owner's", async () => {
  const userId = await h.seedUser("src-1");
  const sessionId = await h.seedSession(userId, "sess-src-1");
  const groupId = await h.seedGroup(sessionId, "srcg@g.us");
  const cited = await h.seedMessage(groupId, "m-cited", "2026-08-01T02:00:00.000Z", {
    text: "deposit RM500 paid",
  });
  const uncited = await h.seedMessage(groupId, "m-uncited", "2026-08-01T03:00:00.000Z", {
    text: "unrelated chatter",
  });
  const summaryId = await h.seedSummary(userId, groupId, {
    decisions: [{ text: "deposit settled", source_message_ids: [cited] }],
  });

  const res = await h.api("src-1", "GET", `/v1/summaries/${summaryId}/sources`);
  assert.equal(res.status, 200);
  const { sources } = res.body as { sources: any[] };
  assert.equal(sources.length, 1);
  assert.equal(sources[0].id, cited);
  assert.equal(sources[0].group_id, groupId);
  assert.equal(sources[0].text, "deposit RM500 paid"); // decrypted with the Account key
  assert.equal(sources[0].sent_at, "2026-08-01T02:00:00.000Z");
  // §41 is "the sources for this claim", never the Account's wider history.
  assert.ok(!sources.some((s) => s.id === uncited));

  // A Summary with no citations has no evidence to show — not an error.
  const empty = await h.seedSummary(userId, groupId, {
    highlights: [{ text: "quiet day", source_message_ids: [] }],
  });
  assert.deepEqual((await h.api("src-1", "GET", `/v1/summaries/${empty}/sources`)).body, {
    sources: [],
  });

  // Another Account's Summary is indistinguishable from one that never existed.
  await h.seedUser("src-2");
  const other = await h.api("src-2", "GET", `/v1/summaries/${summaryId}/sources`);
  assert.equal(other.status, 404);
  assert.equal(
    (await h.api("src-1", "GET", `/v1/summaries/00000000-0000-0000-0000-000000000000/sources`))
      .status,
    404,
  );
});

test("an Operator trades the secret for an httpOnly cookie, and can hand it back", async () => {
  const wrong = await raw("POST", "/admin/session", { body: { secret: "nope" } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers["set-cookie"], undefined);

  const ok = await raw("POST", "/admin/session", { body: { secret: OPERATOR_SECRET } });
  assert.equal(ok.status, 200);
  const header = setCookie(ok);
  assert.match(header, /^walao_op=/);
  assert.match(header, /HttpOnly/); // §55: the console's own scripts cannot read it
  assert.match(header, /SameSite=Lax/);
  const cookie = header.split(";")[0];

  // The cookie alone authorises /admin/*, with no secret header in sight.
  const queue = await raw("GET", "/admin/review/queue", { headers: { cookie } });
  assert.equal(queue.status, 200);

  const out = await raw("DELETE", "/admin/session", { headers: { cookie } });
  assert.equal(out.status, 200);
  assert.match(setCookie(out), /^walao_op=;.*Max-Age=0/);
  assert.equal(
    (await raw("GET", "/admin/review/queue", { headers: { cookie: "walao_op=" } })).status,
    401,
  );
});

// Ticket 31 (§18-34): the two shapes the Today and Groups screens act on. Both
// are data the API already had and did not say out loud — the screens would
// otherwise have to guess them back, and a guess is a wrong write.

test("a Brief item locates itself in its Summary, so the Brief can act on what it shows", async () => {
  const userId = await h.seedUser("brief-1");
  const sessionId = await h.seedSession(userId, "sess-brief-1");
  const g1 = await h.seedGroup(sessionId, "b1@g.us");
  const g2 = await h.seedGroup(sessionId, "b2@g.us");
  await h.seedSummary(userId, g1, {
    highlights: [{ text: "quiet morning", source_message_ids: [] }],
    action_items: [
      { text: "Pay vendor", source_message_ids: [], owner: null, due_at: null, confidence: 1 },
    ],
  });
  // The same item from a second Group: the Brief merges the text and keeps both
  // coordinates, so marking it done marks it done everywhere it came from.
  await h.seedSummary(userId, g2, {
    action_items: [
      { text: "Pay vendor", source_message_ids: [], owner: null, due_at: null, confidence: 1 },
    ],
  });

  const brief = (await h.api("brief-1", "GET", "/v1/briefs/today")).body as any;
  const item = brief.needs_action.find((i: any) => i.text === "Pay vendor");
  assert.equal(item.sources.length, 2);
  for (const s of item.sources) {
    assert.equal(s.section, "action_items");
    assert.equal(s.item_index, 0); // its own index within its own section
  }
  // The index is the section's, not the payload's: "quiet morning" is
  // highlights[0] even though an action item was stored beside it.
  const note = brief.worth_noting.find((i: any) => i.text === "quiet morning").sources[0];
  assert.equal(note.section, "highlights");
  assert.equal(note.item_index, 0);

  // What the Brief hands over is exactly what the state route accepts.
  const s = item.sources[0];
  assert.equal(
    (
      await h.api(
        "brief-1",
        "PUT",
        `/v1/summaries/${s.summary_id}/items/${s.section}/${s.item_index}/state`,
        { state: "complete" },
      )
    ).status,
    200,
  );
  const after = (await h.api("brief-1", "GET", "/v1/summaries")).body as any;
  const stored = after.summaries.find((x: any) => x.id === s.summary_id).states;
  assert.deepEqual(stored, [{ section: "action_items", item_index: 0, state: "complete" }]);
});

test("the Groups list carries each Group's schedule and which Groups the cap has blocked", async () => {
  const userId = await h.seedUser("grp-1");
  const sessionId = await h.seedSession(userId, "sess-grp-1");
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push(await h.seedGroup(sessionId, `cap${i}@g.us`, false));
  await h.pool.query(`UPDATE users SET plan = 'pro' WHERE id = $1`, [userId]);

  // Enabled in order, so the cap has an unambiguous oldest-first ranking.
  for (const id of ids) {
    assert.equal(
      (await h.api("grp-1", "POST", `/v1/groups/${id}/enable`, { attestation_version: VERSION }))
        .status,
      200,
    );
  }
  await h.api("grp-1", "PUT", `/v1/groups/${ids[0]}/schedule`, {
    local_time: "18:30",
    timezone: "Asia/Kuala_Lumpur",
    language: "ms",
  });

  const onPro = (await h.api("grp-1", "GET", "/v1/groups")).body as any;
  assert.deepEqual(
    onPro.groups[0].schedule,
    { local_time: "18:30", timezone: "Asia/Kuala_Lumpur", language: "ms" },
    "the screen shows the schedule it is editing, not an empty form",
  );
  assert.equal(onPro.groups[1].schedule, null);
  assert.ok(!onPro.groups.some((g: any) => g.blocked), "four Groups sit inside Pro's cap");

  // Cancelling to Free (cap 3) blocks the newest enabled Group and only that one
  // — the same ranking processingBlock uses, so the badge cannot disagree with
  // what is actually being read.
  assert.equal((await h.api("grp-1", "POST", "/v1/plan/cancel")).status, 200);
  const onFree = (await h.api("grp-1", "GET", "/v1/groups")).body as any;
  assert.deepEqual(
    onFree.groups.map((g: any) => g.blocked),
    [false, false, false, true],
  );

  // Disabled is not blocked: nothing is being read either way, and saying
  // "blocked" about an off Group would send the merchant to the wrong fix.
  assert.equal((await h.api("grp-1", "POST", `/v1/groups/${ids[3]}/disable`)).status, 200);
  const off = (await h.api("grp-1", "GET", "/v1/groups")).body as any;
  assert.equal(off.groups[3].blocked, false);
  assert.equal(off.groups[3].enabled, false);
});
