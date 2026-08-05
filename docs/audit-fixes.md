# WALAO — Site Audit Findings & Fix Brief

> Hand this file to the implementing agent (Claude). It contains the full site audit,
> the problems found, and concrete fix instructions with acceptance criteria.
> Audit date: 2026-08-05 · Repository: `github.com/MK-Chan-MECACA/walao.git`

## Status — all findings implemented & verified ✅

Verified 2026-08-05 (working tree, uncommitted). Fixes are unstaged for review.

| Finding | Status | Where it landed | Verified by |
|---|---|---|---|
| F1 CSP + security headers | ✅ DONE | `src/app.ts` (`securityHeaders`, `CSP`) | test/web.test.ts: "every response carries the security headers" |
| F2 CDN QR script | ✅ DONE | vendored to `public/vendor/qrcode.min.js`, SRI hash in `public/pair.html` | test: "a body far larger…" / manual (no CDN ref left) |
| F3 Operator session | ✅ DONE | `migrations/025_operator_sessions.sql`, `src/app.ts` | 3 tests: cookie≠secret, server-side sign-out, expiry+purge |
| F4 rate limits + body cap | ✅ DONE | `src/limits.ts`, `migrations/026_rate_limits.sql`, `readRawBody`/`clientIp` in `src/app.ts` | 4 tests: per-email, per-IP, verify cap, oversized body |
| F5 path-guard boundary | ✅ DONE | `src/app.ts` `serveStatic` | test: "a sibling directory that shares public/'s name prefix is not servable" |
| F6 Docker + healthz | ✅ DONE | `Dockerfile` (`USER node`, `EXPOSE`, `HEALTHCHECK`), `GET /healthz` | test: "/healthz answers without a credential" |
| F7 token TTL | ✅ DONE | `migrations/027_token_expiry.sql`, `src/accounts.ts`, `src/api.ts`, `src/retention.ts` | test: "a bearer token expires, and the purge stops the row holding it" |
| F8 `.env` keys | ✅ DONE (inspect/rotate remains human action) | `.env` still gitignored, not tracked | `git ls-files` shows no `.env` |
| F9 test-DB ergonomics | ✅ DONE | `README.md` "Running it locally / Tests" section | `createdb walao_test` documented |
| F10 QR innerHTML | ✅ DONE | `public/pair.js` (DOM-built node) | grep: no `innerHTML` assignment in `public/` |
| F11 robots/favicon/mount | ✅ DONE | `public/robots.txt`, `public/favicon.svg` + all 8 pages, `public/pair.js` | grep |

**Test run (authoritative):** `DATABASE_URL=postgres://postgres@127.0.0.1:5432/walao_test npm test`
→ **tests 164 · pass 164 · fail 0** (47 new tests added on top of the pre-audit 117).
`npm run typecheck` → clean.

**Note from verification:** the SRI hash for the vendored script is recorded as a
comment in `public/pair.html`; since the file is now served same-origin, SRI itself
guards nothing further — the provenance note is what matters. F8's rotate-if-real
step is the one remaining *human* action; everything code-level is done.

## Context for the implementing agent

WALAO is a personal AI information layer over WhatsApp: an Account signs up (email
magic-code login), pairs its own WhatsApp number via an unofficial gateway, enables
specific Groups, and receives scheduled AI Summaries / a Today Brief through a
same-origin web app served from `public/` by `src/server.ts`. Backend is Node 24 +
TypeScript (type-stripped, no build step) + PostgreSQL. Tests use the whole-system
seam in `test/helpers.ts` and must run against a `*_test` database.

Read these before editing:

- `src/app.ts` — the entire route table (webhook, `/v1/*` API, `/admin/*`, static)
- `public/api.js`, `public/layout.js` — shared frontend plumbing
- `src/config.ts`, `src/crypto.ts`, `src/db.ts` — config, crypto, migrations
- `docs/adr/*` — architecture decisions that must not be contradicted
- `package.json` — scripts: `npm run typecheck`, `npm test`

**Hard rules while fixing:**

1. Do not weaken tenant isolation. Every data read must keep `WHERE user_id = $1`.
2. Message bodies and Summary texts must stay out of logs and out of Operator-only
   surfaces (except the explicit quality-review opt-in path).
3. Keep every UI render on `textContent` — nothing user/group-derived reaches
   `innerHTML`.
4. All comparisons of secrets/tokens stay constant-time (`timingSafeEqual` over
   hashed fixed-length inputs).
5. Do not change attestation versions or wording; that is a product decision.
6. Preserve the existing no-build-step static-app architecture; no new
   frameworks.
7. Follow existing conventions: `send(res, status, body)` helper, `api()`/`el()`
   frontend helpers, ticket-numbered comments, tests at the existing seam in
   `test/web.test.ts` style with real Postgres via `test/helpers.ts`.
8. Existing tests must keep passing (see "Test environment" below).

**Test environment:** the suite refuses to run against any database whose name
does not end in `_test` (`test/helpers.ts:29`). To run tests locally:

```bash
createdb walao_test        # or: docker exec -it <pg> createdb -U walao walao_test
DATABASE_URL=postgres://localhost:5432/walao_test npm test
```

---

## Findings, ordered by priority

---

### F1 — HIGH: No Content-Security-Policy or security headers on any response

**Where:** `src/app.ts` — `send()` (~line 859) and `serveStatic()` (~line 805).

**Problem:** No response anywhere sets `Content-Security-Policy`,
`Strict-Transport-Security`, `X-Frame-Options`, `X-Content-Type-Options`, or
`Referrer-Policy`. A single XSS (or the CDN issue in F2) runs with zero
mitigation, the app is clickjackable, and there is no HSTS for what will be a
production SaaS holding WhatsApp-derived message data.

**Fix:**

- Add a helper that sets security headers on every response path (`send()` and
  every `res.writeHead`/`res.end` path in `serveStatic()`), e.g.:

```ts
function securityHeaders(res: ServerResponse): void {
  res.setHeader("content-security-policy", CSP);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
}
```

- CSP must be strict. `public/*.html` currently uses **inline module scripts**, so:
  - move each page's inline module script into its own file under `public/`
    (e.g. `public/today.js`) and use `script-src 'self'` (recommended), or
  - keep inline scripts only with `script-src 'self' 'unsafe-inline'` (weaker).
  - The QR library from F2 must be local for `script-src 'self'` to work.
- Suggested CSP to start from (after moving scripts out):
  `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;
  connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self';
  frame-ancestors 'none'`.
- Add tests in `test/web.test.ts` asserting HTML/API responses carry
  `content-security-policy`, `x-content-type-options: nosniff`, and
  `x-frame-options`.

**Acceptance:** responses for `/`, `/today`, `/v1/*`, and `/webhooks/gateway` carry
all four headers; no CSP violations when exercising signup → verify → today →
groups in a browser.

---

### F2 — HIGH: Third-party CDN script with no SRI and no CSP (account-takeover path)

**Where:** `public/pair.html:8`

```html
<script src="https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js"></script>
```

**Problem:** This is the only external dependency in the app, loaded with no
`integrity` attribute and no CSP. A `<script>` from another origin executes with
the page's origin, so a tampered jsdelivr build can issue same-origin `fetch()`
calls; the httpOnly `walao_session` cookie rides along automatically, enabling
`/v1/export`, `/v1/outbound`, and `DELETE /v1/account` — full account takeover
including data exfiltration.

**Fix (vendor it — do not keep the CDN):**

1. Download `https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js`
   into `public/vendor/qrcode.min.js` (and commit it).
2. Compute its SRI hash and record it in a comment next to the reference.
3. Replace the CDN `<script>` line in `public/pair.html` with
   `<script src="/vendor/qrcode.min.js"></script>`.
4. Replace the `innerHTML` QR render with DOM construction (see F10).

---
### F3 — HIGH: Operator secret is reused verbatim as the session cookie

**Where:** `src/app.ts` — `setCookie(req, res, "walao_op", secret)` (~line 147) and
the check at ~line 153: `operatorOk(header(...) || cookie(req, "walao_op") ?? "")`.

**Problem:** The `walao_op` cookie value *is* the permanent operator secret. If the
cookie leaks, the operator credential is compromised permanently; `DELETE
/admin/session` only clears the cookie and cannot revoke anything; the full secret
is replayed on every request.

**Fix — introduce a revocable operator session, mirroring the account flow:**

1. New migration `migrations/025_operator_sessions.sql` (idempotent, like
   `001_init.sql`):

```sql
CREATE TABLE IF NOT EXISTS operator_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_sha256 text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '12 hours'
);
```

2. `POST /admin/session`: on a correct secret, mint `randomBytes(32).toString("hex")`,
   store `hashToken(token)`, set cookie `walao_op` to the raw token.
3. `DELETE /admin/session`: delete the session row **and** clear the cookie.
4. The `/admin/*` check (line 153) becomes: accept the secret in the
   `x-walao-operator-secret` header (legacy/scripted use) **or** look up the cookie
   token's hash in `operator_sessions` where `expires_at > now()`.
5. Keep the constant-time comparison for the header path (existing `operatorOk`). A
   unique-indexed DB lookup is fine for the cookie path.
6. Expired sessions are refused (401); purge expired rows on the existing 60s timer
   or in `purgeExpired`.
7. `public/ops.html` works unchanged (it posts to the same routes); verify Sign out
   truly invalidates server-side.

**Acceptance:** new tests in `test/web.test.ts`: (a) operator session cookie
authenticates; (b) `DELETE /admin/session` invalidates the session (next request
401); (c) the cookie value is not equal to the operator secret; (d) expiry refuses
(set `expires_at` in the past).

---

### F4 — HIGH: No rate limiting / abuse control — email-bomb + DB-spam vector

**Where:** `src/accounts.ts` — `signup()` (~line 35) and `issueCode()` (~line 69);
`src/app.ts` route block for `/v1/signup|login|verify` (~line 240).

**Problem:** No throttling anywhere. `signup` accepts any regex-valid email and each
call sends a real email (Resend in production), so an attacker can mail-bomb
arbitrary addresses and spam the mail service; `ON CONFLICT DO UPDATE` plus
`recordAttestation` plus `issueCode` run on every call, growing rows. `verify` has
no attempt counter. No request-body size limit exists anywhere, enabling memory DoS.

**Fix:**

1. **Body-size cap:** in `readRawBody` (`src/app.ts:819`), abort (400) when
   accumulated bytes exceed ~1 MB (WhatsApp events are far smaller).
2. **Email-rate limiting (per IP + per email):** a small DB-backed limiter in a new
   `src/limits.ts` (or a counter column on `users` reset by timestamp). Keep it
   simple and testable:
   - `POST /v1/signup` and `POST /v1/login`: at most N requests per email per hour
     (e.g. 5) and per IP per hour (e.g. 20). Over-limit returns the same `202
     {ok:true}` envelope — never leak limiter state with a different answer
     (preserves the anti-enumeration property).
   - `POST /v1/verify`: at most e.g. 20 attempts per 15 minutes per IP and 10 per
     email; over-limit returns 400 `invalid_code` (identical shape to a wrong code).
3. Do not break the anti-enumeration contract: known and unknown emails still answer
   202.
4. Keep the constant-time code comparison as-is.

---

### F5 — MEDIUM: Static path-traversal guard is a prefix check without a boundary

**Where:** `src/app.ts` `serveStatic()` (~line 797):

```ts
const file = path.resolve(PUBLIC_DIR, "." + rel);
if (!file.startsWith(PUBLIC_DIR)) return false;
```

**Problem:** A sibling directory whose name starts with `public` (e.g. `public_html`)
would pass the guard and be served. Latent today (no such sibling exists), but it is
a traversal-adjacent bug worth closing.

**Fix:**

```ts
if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return false;
```

**Acceptance:** new test in `test/web.test.ts`: a request for `/%2e%2e/public-secret/file`
(and `..%2f..`) yields 404; creating a temp sibling dir named `public-<something>` with a
marker file must not be servable.

---

### F6 — MEDIUM: Docker runs as root; no healthcheck; migrations run on every boot

**Where:** `Dockerfile`, `src/db.ts:16` (`migrate()` applied in `server.ts` on boot).

**Problem:** The container holds `WALAO_ENC_KEY` and DB credentials and runs as root —
defense-in-depth gap. No `HEALTHCHECK`/`EXPOSE`. `migrate()` re-runs the full migration
set on every boot with no applied-ledger, which is racy for multi-instance deploys.

**Fix (Docker):**

1. Add `USER node` (the `node:24-slim` image defines the `node` user) after `COPY . .`,
   and chown if the app needs write access (it should not — no local file writes).
2. Add `EXPOSE 3000` and a `HEALTHCHECK`. There is currently no health endpoint — add
   `GET /healthz` in `src/app.ts` (public, no data, no auth) returning `200 {ok:true}`.
   `HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"` (use a node one-liner if `wget`/`curl` are absent from `node:24-slim`).
3. Migrations-on-boot: do not redesign to a full ledger in this pass unless trivial.
   Document in `Dockerfile`/README that the image is single-replica for now. (Optional:
   add a `schema_migrations` ledger and apply only new files — the existing migrations are
   idempotent, so this is low-risk.)

**Acceptance:** `docker build` succeeds; container runs as non-root
(`docker run --rm <image> id` shows `node`); `GET /healthz` returns 200 against a booted
instance; healthcheck passes.

---

### F7 — MEDIUM: Session and operator bearer tokens never expire

**Where:** `src/accounts.ts` — `api_token_sha256` minted in `verify()` (~line 103);
`src/api.ts` `authenticate()`.

**Problem:** One non-expiring token per account, no absolute TTL, no idle timeout. A
leaked token works until an explicit logout.

**Fix (small, non-breaking):**

1. Add `token_expires_at timestamptz` to `users` in a new migration.
2. Mint with `now() + interval '30 days'`. In `authenticate()` add
   `AND token_expires_at > now()`.
3. On `verify()` a new token always replaces the old (already the behavior), so signing in
   again refreshes the TTL.
4. Purge expired `api_token_sha256` values opportunistically (ride the existing purge
   timer). Revoke-on-expiry only; do not add a lockout policy (out of scope).
5. Keep the session cookie a browser-session cookie (no Max-Age) — the server-side TTL is
   the control.

---

### F8 — LOW: Real-looking API keys in plaintext local `.env`

**Where:** `.env` (gitignored — **do not commit**; only `.env.example` is tracked).

**Problem:** `.env` currently holds non-empty `ANTHROPIC_API_KEY` (108 chars),
`RESEND_API_KEY` (36), and `WAAPI_API_KEY` (36) in plaintext on the dev machine. If any
of these are production keys, they are an exposure.

**Fix:**

1. Inspect the keys; if any are real/production keys, rotate them at the provider and
   replace with throwaway developer keys.
2. Leave `.env` out of git (already ignored). Optionally add a comment convention: dev
   keys only.
3. Do not add any new secret to `.env.example`.

**Acceptance:** no `.env` in `git ls-files`; dev `.env` contains only dev-scoped keys.

---

### F9 — LOW: Test suite cannot run out of the box (needs `*_test` DB)

**Where:** `test/helpers.ts:29` (guard), `docker-compose.yml` (only provisions `walao`),
`package.json` (`test` script).

**Problem:** `npm test` hard-fails unless `DATABASE_URL` ends `_test`; nothing provisions
that database, and the README does not say how.

**Fix:**

1. Add a `db-test` script or document the one-liner in the README Testing section:
   `createdb walao_test` (or `docker compose exec postgres createdb -U walao walao_test`).
2. Optionally add a `psql`-free script `scripts/ensure-test-db.ts` that creates
   `walao_test` via the `postgres` maintenance DB, guarded to run only when the target
   name ends `_test`.
3. Keep the guard itself — it is correct.

**Acceptance:** documented path from fresh clone to green test run.

---

### F10 — LOW: `innerHTML` used for the QR image in `pair.html`

**Where:** `public/pair.html:87`

```js
$("qr-code").innerHTML = qr.createImgTag(6);
```

**Problem:** Violates the codebase's own "nothing reaches innerHTML" convention
(`layout.js:29`); input is library-generated so the current risk is negligible, but the
sink should not exist.

**Fix:** build the `<img>` with `el()`/DOM (or `document.createElement`) and set
`src = qr.createDataURL()`; then `replaceChildren`. Confirm `qrcode.min.js` exposes a
data-URL method (the 1.4.4 API has `createDataURL(cellSize, margin)`).

**Acceptance:** pairing still shows the QR; grep shows no `innerHTML` anywhere in
`public/`.

---

### F11 — LOW: Missing `robots.txt` / `favicon`; unawaited `mount()` in `pair.html`

**Where:** `public/` — no `robots.txt`, no `favicon.ico`; `public/pair.html:59,157,166`.

**Fix:**

1. Add `public/favicon.svg` (simple WALAO mark) and reference it in each `<head>` via
   `<link rel="icon" href="/favicon.svg" />` (all 8 pages).
2. Add `public/robots.txt` with `User-agent: *` and `Disallow: /admin/`,
   `Disallow: /v1/`.
3. In `pair.html`, `await mount("/pair")` at the three call sites (wrap in the existing
   async handlers or add `.then`), to avoid unhandled-rejection noise.

**Acceptance:** no console warnings for favicon; robots.txt served; pair page has no
unhandled promise rejections on connect/disconnect.

---

## Suggested implementation order

1. F1 + F2 (CSP + vendor QR) — together they unlock strict `script-src 'self'`.
2. F3 operator sessions (migration + routes + tests).
3. F4 rate limits + body cap (tests).
4. F5 path-guard boundary (tiny + test).
5. F6 Docker + `/healthz`.
6. F7 token TTL.
7. F8–F11 hygiene.

## Verification checklist (run before declaring done)

```bash
npm run typecheck
createdb walao_test   # once
DATABASE_URL=postgres://localhost:5432/walao_test npm test
```

- All existing tests pass, plus the new ones for F1–F7.
- Manual smoke against `npm run dev`: signup → verify → pair (QR renders, no external
  requests) → groups → today → settings/export → logout → ops gate + sign-out.
- `git status` shows no `.env` change committed.

