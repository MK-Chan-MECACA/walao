# WALAO App Spec — the web surface over the v2 API

> Status: `ready-for-agent` (label recorded here — no issue tracker configured)
> Extends: `docs/spec-walao-v2.md` (shipped through ticket 28). v2 remains the backend contract; this document specifies the client surface it was always written for and the small number of backend additions that surface requires.
> Sources: the shipped v2 codebase (`src/app.ts` route table, `src/surfaces.ts`, `src/brief.ts`, `src/block.ts`), README §409 "Sprint 3 — Today Brief App", and the design decisions settled in the grilling session of 2026-08-03.
> Legend: every story here is **(new)** — no client exists today. Unmarked implementation notes restate shipped backend behaviour the app depends on.

## Problem Statement

The v2 backend is complete: 113 stories, 129 whole-system tests, an HTTP API covering identity, pairing, Groups, Summaries, Items, Reminders, Memories, Ask, privacy, commerce and Operator support. None of it is reachable by a human. Every story that says "the Account holder can…" is, today, a `curl` command.

That gap is not cosmetic. Three of the product's load-bearing promises are only true if a person can see them. "Every claim carries a source" is worthless if the source cannot be opened. "You control retention, export and deletion at all times" is worthless if the control is an HTTP verb. "A Group is off until you enable it with an Attestation" is worthless if the Attestation text is a JSON field nobody renders. The backend can be correct and the product still fail to make its own honesty legible.

The v2 spec names "the app" eleven times as the surface for history, settings and Ask WALAO, and never specifies it. This document does.

## Solution

A mobile-first web app, served same-origin by the existing Node process from `public/`, with no build step: plain HTML, ES modules, one hand-written stylesheet. Eight pages, one per job — auth, pair, today, groups, lists, ask, settings, and an Operator page at `/ops`. The browser does the routing; the server adds a static branch and a path-traversal guard.

Authentication moves from a bearer token pasted by a developer to an httpOnly cookie set at verification, because the app runs in a browser and the token it holds is non-expiring and, until now, non-revocable. A `POST /v1/logout` makes it revocable. The bearer header keeps working unchanged, so tests and API clients are untouched.

Three backend gaps block the surface and are filled here: `AnswererPort` has no production implementation, so Ask WALAO 500s; no endpoint returns the messages a Summary cites, so citations cannot be expanded; and the Operator secret has no browser-safe entry path. Each is small, each is testable at the existing whole-system seam, and all three land before a line of HTML exists.

## User Stories

### Shell & session

1. As an Account holder, I want the app to work on the phone I already hold, so that reading my Brief does not mean finding a laptop.
2. As an Account holder, I want my session to survive closing the tab, so that I am not re-verifying an email code every time I check something.
3. As an Account holder, I want a credential that page scripts cannot read, so that a single injected script cannot take my Account, export my data, or delete it.
4. As an Account holder, I want a log-out that genuinely ends the session, so that logging out on a borrowed phone means something.
5. As an Account holder, I want to be returned to the login screen when my credential stops working, so that a session invalidated elsewhere is an obvious prompt rather than a page of errors.
6. As an Account holder, I want one status line on every screen telling me whether WALAO is processing right now and why not, so that "nothing is happening" is never a mystery I have to diagnose.
7. As an Account holder, I want a failed request to say what failed in words, so that I can act on it instead of reloading hopefully.

### Auth

8. As a merchant, I want to sign up with my email address and read the data-processing terms on the same screen I accept them, so that what I agreed to is something I actually saw.
9. As a merchant, I want to enter the emailed code and land in the product, so that signup is one continuous act rather than a handoff.
10. As a returning Account holder, I want to log in with my email and a code, so that there is no password to remember or lose.
11. As a visitor, I want the terms readable before I have an Account, so that I can decide without signing up first.

### Pair

12. As an Account holder, I want the ban-risk disclosure shown in full before pairing, with the pairing button inert until I affirm it, so that the risk is a decision rather than a scroll-past.
13. As an Account holder, I want the pairing code displayed clearly with instructions for where it goes in WhatsApp, so that pairing does not require reading documentation.
14. As an Account holder, I want to watch my connection reach "connected" without reloading, so that I know the pairing worked.
15. As an Account holder, I want my Trial's remaining days visible from the moment pairing completes, so that the clock is never a surprise.
16. As an Account holder, I want connection history — every Session, its status and when it changed — so that a disconnection has a visible record.
17. As an Account holder, I want to disconnect a Session deliberately, so that stopping is as easy as starting.

### Today

18. As an Account holder, I want my Today Brief in three buckets — needs action, decided, worth noting — so that the first thing I see is what demands me.
19. As an Account holder, I want each Item to show which Group it came from, so that I can weigh it without opening anything.
20. As an Account holder, I want to expand an Item and read the exact messages it was drawn from, so that I can check a claim rather than trust it.
21. As an Account holder, I want to open the source Group in WhatsApp where my phone supports it, so that replying is one tap from the Brief.
22. As an Account holder, I want to mark an Item complete or dismissed, and to clear that mark, so that the Brief reflects what I have dealt with.
23. As an Account holder, I want to confirm an action item into a Reminder, so that something I must do outlives today's Brief.
24. As an Account holder, I want a Brief that overlaps a Coverage Gap to say so on its face, so that I never mistake a partial Brief for a complete one.
25. As an Account holder with no Brief yet, I want to be told what is missing — no Session, no enabled Group, no messages, nothing scheduled — so that an empty screen is a next step rather than a dead end.
26. As an Account holder, I want to browse past Summaries by date and Group, so that an old decision is retrievable without re-reading WhatsApp.

### Groups

27. As an Account holder, I want to see every Group my Session can see, and whether each is enabled, so that what WALAO is and is not reading is one glance.
28. As an Account holder, I want to read the group-responsibility Attestation in full and affirm it in the same action that enables the Group, so that consent and effect are never separated.
29. As an Account holder, I want the disclosure template offered for copying when I enable a Group, so that telling the other members is the easy path.
30. As an Account holder, I want to disable a Group and have it stop being read immediately, so that turning it off is trustworthy.
31. As an Account holder, I want to set each Group's summary time, timezone and language, so that the Brief arrives when and how I read.
32. As an Account holder, I want to delete a Group's stored data separately from disabling it, so that "stop reading" and "forget what you read" are distinct choices.
33. As an Account holder over my Plan's Group cap, I want the blocked Groups marked as blocked with the reason, so that the cap is visible where I would act on it.
34. As an Account holder, I want enabling past my cap to be refused with an explanation and my options, so that a refusal is not a dead end.

### Reminders & Memories

35. As an Account holder, I want my open Reminders listed with owner and due date, so that what I confirmed is in one place.
36. As an Account holder, I want to edit a Reminder's owner and due date and mark it done or dismissed, so that the list stays true.
37. As an Account holder, I want Memory candidates listed with their expiry, so that I can promote what matters before it lapses.
38. As an Account holder, I want to confirm, edit and delete Memories, so that what WALAO remembers about my business is mine to curate.
39. As an Account holder, I want each Reminder and Memory to link back to the Summary that produced it, so that provenance survives the promotion.

### Ask

40. As an Account holder, I want to ask a question in plain language over my own data, so that retrieval does not mean scrolling.
41. As an Account holder, I want every answer to carry its sources, so that I can verify before acting.
42. As an Account holder, I want "I don't know" when the data does not support an answer, so that the tool's silence is informative rather than invented.
43. As an Account holder, I want to see that Ask only searches Groups I enabled, so that the boundary is visible in the surface that could most easily blur it.

### Settings

44. As an Account holder, I want my Plan, current usage against its caps, and Trial state on one screen, so that where I stand is never a support question.
45. As an Account holder, I want per-Group Credit burn over 30 days, so that an expensive Group is findable and mutable.
46. As an Account holder, I want to cancel to Free and be told plainly that nothing is deleted, so that stopping payment is never confused with losing my data.
47. As an Account holder, I want to set my retention window between 1 and 30 days, so that how long raw messages live is my decision.
48. As an Account holder, I want to pause and resume all processing with one control, so that stopping is immediate and reversible.
49. As an Account holder, I want to export everything I have, so that leaving is possible.
50. As an Account holder, I want to delete my Account behind a deliberate confirmation that states what deletion destroys, so that an irreversible act is never one stray tap.
51. As an Account holder, I want to grant and revoke quality-review access to my Summaries, so that the one exception to "nobody can read your Summaries" is mine to give and take back.
52. As an Account holder, I want every Attestation I have made listed with its version and date, so that my own consent record is inspectable.
53. As an Account holder, I want Tier 1 outbound presented as an explicit authorisation with its wording shown, not as a casual toggle, so that a capability that sends messages as me is never enabled by accident.

### Operator console

54. As an Operator, I want to enter the operator secret once and work in the console, so that support does not mean assembling `curl` invocations under pressure.
55. As an Operator, I want the secret never readable by page scripts, so that the console's own code cannot leak the key to the whole product.
56. As an Operator, I want to look up an Account by id and see its metadata — counts, job status, connection history, token usage, Plan and block reason — so that I can answer a support question in one screen.
57. As an Operator, I want to change an Account's Plan directly, so that upgrades work before payment integration exists.
58. As an Operator, I want the product-wide halt switch with its current state visible, so that the emergency control is not a command I have to remember correctly at 3am.
59. As an Operator, I want the Malay quality review queue and a way to record a review, so that the weakest language lane has a workable surface.
60. As an Operator, I want the console to be structurally incapable of showing me a message body, so that the privacy promise does not depend on my restraint.

## Implementation Decisions

### Platform

- Mobile-first web app, served **same origin** by the existing `node:http` server from `public/`. No second deploy target, no CORS, no cross-host credential.
- **No build step.** Plain HTML, native ES modules, one hand-written `public/app.css`. Nothing from a CDN; every asset is local.
- **Multi-page, not SPA.** The browser owns routing, history, the back button and scroll restoration. Pages: `index.html` (auth), `pair.html`, `today.html`, `groups.html`, `lists.html`, `ask.html`, `settings.html`, `ops.html`.
- Static branch in `app.ts` resolves `GET /` → `index.html` and `GET /foo` → `public/foo.html`, falling through to the existing 404. Path resolution is `path.resolve` against `public/` with a prefix check — a request that escapes the directory is a 404, not a file. This is input validation at a trust boundary and is not simplified away.
- English-only chrome. Per-Group Summary language (`zh | en | ms`) is unchanged and unrelated.
- Styling is one stylesheet, ~200 lines: CSS custom properties for the palette, `prefers-color-scheme` for dark, system font stack, no framework.

### Session

- `POST /v1/verify` additionally sets `Set-Cookie: walao_session=<token>; HttpOnly; SameSite=Lax; Path=/`, with `Secure` appended unless the request `Host` is `localhost` or `127.0.0.1`. No new env var: dev over plain HTTP works, anything deployed gets the flag, and there is no silent misconfiguration where the cookie is set but never sent.
- `authenticate()` reads the bearer header first and falls back to the cookie. Existing clients and all 129 tests are unaffected.
- `SameSite=Lax` plus same-origin JSON writes covers CSRF: every mutating route is `POST`/`PUT`/`DELETE` with a JSON body, which no cross-site form can forge.
- New `POST /v1/logout`: clears the cookie and sets `api_token_sha256` to NULL, so the token is dead rather than merely forgotten. Authenticated route — logging out is an Account action.
- **One live token per Account** stays the model. `verify()` overwrites `api_token_sha256`, so a second device logs the first out. The app treats any 401 as "session ended": clear local state, redirect to `index.html` with an explanatory line. A `api_tokens` table for multi-device is a later ticket and a contained one — new table, `authenticate()` joins it, `verify()` inserts, `logout` deletes one row.
- The shared `api.js` helper wraps `fetch` with `credentials: 'same-origin'`, JSON encode/decode, and central 401 handling, so no page reimplements session expiry.

### Screens and the routes behind them

Every route below is shipped and unchanged unless marked **new**.

| Page | Reads | Writes |
| --- | --- | --- |
| `index` | `GET /v1/terms` | `POST /v1/signup`, `POST /v1/login`, `POST /v1/verify` |
| `pair` | `GET /v1/onboarding`, `GET /v1/connections`, `GET /v1/status`, `GET /v1/usage` | `POST /v1/connections`, `POST /v1/connections/:id/disconnect` |
| `today` | `GET /v1/briefs/today`, `GET /v1/summaries`, **new** `GET /v1/summaries/:id/sources` | `PUT /v1/summaries/:id/items/:section/:index/state`, `POST /v1/summaries/:id/action-items/:index/confirm` |
| `groups` | `GET /v1/groups`, `GET /v1/attestation-texts`, `GET /v1/disclosure-template` | `POST /v1/groups/:id/enable`, `POST /v1/groups/:id/disable`, `PUT /v1/groups/:id/schedule`, `DELETE /v1/groups/:id` |
| `lists` | `GET /v1/reminders`, `GET /v1/memories`, `GET /v1/memories/candidates` | `PUT /v1/reminders/:id`, `POST /v1/summaries/:id/memory-candidates/:index/confirm`, `PUT /v1/memories/:id`, `DELETE /v1/memories/:id` |
| `ask` | — | `POST /v1/ask` |
| `settings` | `GET /v1/usage`, `GET /v1/retention`, `GET /v1/quality-review`, `GET /v1/attestations`, `GET /v1/attestation-texts`, `GET /v1/export` | `PUT /v1/retention`, `PUT /v1/quality-review`, `POST /v1/pause`, `POST /v1/resume`, `POST /v1/plan/cancel`, `POST /v1/tier1`, `DELETE /v1/account`, **new** `POST /v1/logout` |
| `ops` | `GET /admin/accounts/:id`, `GET /admin/review/queue` | **new** `POST /admin/session`, `PUT /admin/accounts/:id/plan`, `POST /admin/halt`, `POST /admin/resume`, `POST /admin/review` |

- `GET /v1/messages` gets **no screen**. It returns every message the Account has, decrypted and unpaginated; rendering raw bodies in the app buys no user job and undercuts the privacy posture. It stays an API route.
- `GET /v1/review/weekly` gets no screen in this spec — it is a product-owner artefact, not an Account surface.

### Status banner

- One shared module renders `GET /v1/status` on every authenticated page: `processing`, the block `reason` if any, Session health, and the open Coverage Gap.
- Each `BlockReason` maps to one plain-English line and, where one exists, one action:
  - `halted` — "WALAO is paused product-wide." No action.
  - `unpaid` — "There's a billing problem on this Account." Contact support.
  - `paused` — "You paused processing." Resume.
  - `unpaired` — "No WhatsApp connected yet." Pair.
  - `disconnected` — "WhatsApp disconnected." Re-pair.
  - `over_group_cap` — "More Groups enabled than your Plan allows." Manage Groups or upgrade.
  - `over_daily_messages` / `over_daily_credits` — "Daily limit reached; resets at midnight UTC." Upgrade.
- The banner is the only place these reasons are worded. No page invents its own copy for a block.

### Citations

- **New** `GET /v1/summaries/:id/sources` returns the messages that Summary's items cite — `{ id, group_id, sender_ref, sender_name, sent_at, text }` — tenant-scoped, decrypted with the Account key, restricted to `source_message_ids` present in that Summary's payload. It never returns the Account's wider history.
- The app expands an Item in place to show its evidence. This is the mechanism that makes "every claim carries a source" a fact the merchant can check.
- `jump_url` already exists (`surfaces.ts:19`, `whatsapp://chat?jid=…`) and is rendered as an "Open in WhatsApp" affordance. WhatsApp publishes no guaranteed deep link to a group or a message, so the scheme is best-effort: inline sources are the reliable path and the link is the bonus. If a client that ignores the scheme becomes common, the existing `ponytail:` note in `surfaces.ts` records the upgrade path.

### Ask WALAO

- `src/answerer/anthropic.ts` and `src/answerer/local.ts` implement `AnswererPort`, mirroring `src/summarizer/anthropic.ts` and `local.ts` exactly: real model when `ANTHROPIC_API_KEY` is set, deterministic local stand-in when it is not, chosen in `server.ts` by the same conditional the summarizer uses.
- Retrieval, permission filtering and source validation already live in `src/ask.ts` and are not touched. Only the model call is added.
- The answerer holds no tool access, receives Group text as untrusted data, and returns "I don't know" rather than inventing — the constraints already stated for the summariser apply unchanged.

### Operator console

- **New** `POST /admin/session` takes the operator secret in a JSON body, compares it constant-time exactly as the existing `/admin/*` gate does, and sets `walao_op` as an httpOnly cookie with the same `Secure`/`SameSite` rules as the Account cookie. The secret never reaches JavaScript or storage. `DELETE /admin/session` clears it.
- The `/admin/*` gate accepts the header or the cookie, same fallback shape as the Account gate.
- The console drives only shipped endpoints. It shows metadata only; the review queue remains the single exception and is already gated on `quality_review_opt_in`.
- **Known gap, recorded not solved:** the operator secret is shared and static, so there is no per-Operator identity and no attribution for who changed a Plan or halted the product. Per-Operator accounts are what `spec-walao-v2.md:314` puts out of scope, so this is deliberate. Revisit when more than one person holds the secret.
- Building `/ops` at all takes the narrow reading of that same line — it bans customer-facing team and role management, not an internal page over endpoints the product already ships.

## Testing Decisions

No new seam. Everything new that can fail meaningfully is reachable over HTTP and is tested at `makeHarness()`, alongside the existing 129 tests.

Backend behaviour with dedicated tests:

- `POST /v1/verify` sets an httpOnly cookie, and that cookie alone authenticates a subsequent request.
- The `Secure` attribute is absent for a `localhost` Host and present otherwise.
- The bearer header still authenticates with no cookie present — the regression guard for every existing test.
- `POST /v1/logout` clears the cookie and the old token is rejected afterwards.
- `GET /` serves the shell; a traversal attempt (`/../src/config.ts` and encoded variants) 404s and never reads outside `public/`.
- `GET /v1/summaries/:id/sources` returns only messages cited by that Summary, refuses another Account's Summary with 404, and returns nothing decryptable after the Account is deleted.
- `POST /admin/session` sets the operator cookie for the right secret, 401s for the wrong one, and the cookie then authorises `/admin/*`.
- The local Answerer returns deterministic, source-carrying output and "I don't know" on unsupported questions.

The UI itself gets no browser test framework. Its failure modes are auth and data shape, both covered above; the rest is verified by click-through, with real-Chrome screenshots per screen as each page ticket lands. Playwright becomes worth its ~300MB and second CI runner once the app is stable and the flows are worth regression cover — not before.

## Ticket Sequence

1. **Spec** — this document, committed alone.
2. **Ticket 29 — backend enablers.** Cookie auth, `POST /v1/logout`, static serving with traversal guard, `GET /v1/summaries/:id/sources`, `AnthropicAnswerer` + `LocalAnswerer` wired in `server.ts`, `POST /admin/session`. Tests as listed. No HTML. Suite green before any UI exists, so a UI bug can never be mistaken for an auth bug.
3. **Ticket 30 — shell.** `app.css`, `layout.js` (nav + status banner), `api.js` (fetch wrapper, central 401), `index.html` (signup/login/verify), `pair.html`. First point the product is visible.
4. **Ticket 31 — the core loop.** `today.html` (buckets, inline sources, item states, confirm to Reminder, gap notice, empty states) and `groups.html` (enable with Attestation, disable, schedule, delete data, cap state).
5. **Ticket 32 — the rest of the Account.** `lists.html`, `ask.html`, `settings.html`.
6. **Ticket 33 — `ops.html`.**

Each ticket commits and pushes on its own.

## Out of Scope

- **SMTP.** Login codes still go to the server log (`app.ts:71-77`). The app is fully usable in development by reading the code from the terminal; no real user can onboard until mail is wired. That is its own ticket and it gates public launch, not this work.
- Multi-device sessions — the `api_tokens` table described above, deferred until the single-token logout is felt as a problem.
- Per-Operator identity and attribution.
- Non-English chrome, and translated Attestation wording — the latter is a legal decision about which language version binds, not a UI task.
- Native apps, push notifications, offline support, service workers. Delivery is WhatsApp; the app is the surface for depth.
- A raw-messages browser.
- Payment collection — unchanged from v2. Plan changes remain Operator actions.
- Any build step, bundler, framework or component library.

## Further Notes

- The riskiest ticket is 29, and only because of the cookie. `SameSite=Lax` plus same-origin JSON is the right CSRF posture here, but it is right *because* every mutating route is a JSON verb — if a future route ever accepts form-encoded input, that reasoning silently expires. Recorded here because it is invisible at the call site.
- The single-token model is a UX cost the app makes visible for the first time. Watch for it in support traffic; the fix is scoped and cheap when it is earned.
- `today.html` is the page most likely to justify the build step we declined. Nested items with per-item optimistic state is exactly where hand-rolled DOM updates get ugly. If that page fights back hard enough, take Vite and React for the whole app rather than for one page — a mixed stack costs more than either choice alone.
- Every screen renders wording the API serves (`GET /v1/terms`, `/v1/attestation-texts`, `/v1/disclosure-template`, `/v1/onboarding`) rather than hardcoding it. Consent copy has versions, and a hardcoded string is a version that lies.
