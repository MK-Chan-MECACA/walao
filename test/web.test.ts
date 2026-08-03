import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { makeHarness, OPERATOR_SECRET, type Harness } from "./helpers.ts";
import { DATA_PROCESSING_TERMS as TERMS } from "../src/attestations.ts";
import { ATTESTATION_VERSION as VERSION } from "../src/subscriptions.ts";

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
    ["/pair", /^text\/html/],
    ["/today", /^text\/html/],
    ["/groups", /^text\/html/],
    ["/app.css", /^text\/css/],
    ["/api.js", /^text\/javascript/],
    ["/layout.js", /^text\/javascript/],
  ] as const) {
    const res = await raw("GET", path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers["content-type"] as string, type, path);
  }
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
