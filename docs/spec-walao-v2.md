# WALAO v2 Spec — SaaS Product in Ubiquitous Language

> Status: `ready-for-agent` (label recorded here — no issue tracker configured; run `/setup-matt-pocock-skills` to migrate)
> Supersedes: `docs/spec-walao-v1.md` (Sprints 1–5, shipped through ticket 16). v1 remains the historical record of what was built; this document is the current spec.
> Sources: `CONTEXT.md` domain glossary (2026-08-01), ADR-0001 (shared gateway), ADR-0002 (per-Account envelope encryption), ADR-0003 (Singapore residency), and the shipped v1 codebase.
> Legend: stories marked **(new)** describe behaviour not yet built. Unmarked stories restate shipped behaviour in the ubiquitous language and are the regression contract.

## Problem Statement

A merchant's working life happens in a handful of busy WhatsApp groups. Those groups produce hundreds of messages a day, but only a few outcomes matter: what was decided, what needs a reply, which dates and payments were named, and what matters but can wait. Notifications say only "something is new" — never what deserves attention. The merchant loses 30–60 minutes a day scrolling, still misses decisions and deadlines, and cannot retrieve an old decision without re-reading hundreds of messages.

Selling that relief as a hosted product adds a second problem the merchant feels just as sharply. They have to hand a stranger's software access to conversations that are not only theirs — other people are in those groups. So the product must be legible about exactly what it holds, on whose instruction, for how long, and what happens when they stop paying or walk away. Vague answers to any of those are a reason not to sign up, independent of how good the summaries are.

## Solution

WALAO is a personal AI information layer over WhatsApp, sold as a hosted SaaS. An Account is created by signing up with a verified email address, pairs its own WhatsApp Session, enables specific Groups, and receives a Today Brief at a chosen time in its own chat with itself: decisions, action items, dates and open questions, each Item carrying references back to the messages it came from. The Account holder can ask questions over their own data, confirm Items into Reminders, promote candidates into Memories, and control retention, export and deletion at all times.

The product is honest about its boundaries by construction, not by policy prose. A Group is off until enabled with a versioned Attestation. Message bodies are encrypted with a per-Account key, so deleting an Account crypto-shreds its data everywhere it still exists. An Operator can see counts, job status and connection health, and can never read a message or Summary body unless the Account opted into quality review. Any window when the WhatsApp Session was down is a Coverage Gap, and every Summary that overlaps one says so instead of pretending to be whole. The pipeline asks exactly one question before it processes anything — is there a Processing Block on this Account — and one answer covers paused, unpaired, disconnected, unpaid, halted and over-cap alike.

Commerce is deliberately small: two Plans, a 14-day Trial that starts at pairing and needs no card, Credits as a unit of measurement rather than a balance, and a Cancellation that returns an Account to Free without deleting anything it made.

## User Stories

### Account & identity

1. As a merchant, I want to create an Account with my email address and verify it, so that my login and my bill belong to a real identity independent of any WhatsApp number. **(new)**
2. As an Account holder, I want to log in with my verified email and receive an API credential, so that every request the app makes is attributable to my Account. **(new)**
3. As an Account holder, I want my Account to exist and be usable before I have ever paired WhatsApp, so that I can read the terms, see the Plans and decide, without connecting anything first. **(new)**
4. As an Account holder, I want every piece of data in the system to belong to exactly one Account, so that isolation and deletion have a single, obvious boundary.
5. As an Account holder, I want at most one WhatsApp Session on my Account, so that there is never ambiguity about which connection my Groups came from.
6. As an Account holder, I want to affirm the data-processing terms at signup and have that Attestation stored with the version of the wording I was shown, so that what I agreed to is a fact on the record, not a memory. **(new)**

### Pairing & WhatsApp Session

7. As an Account holder, I want a plain-language explanation of data use, retention, AI providers and unofficial-gateway risk before anything is processed, so that I consent with full knowledge.
8. As an Account holder, I want to affirm that I accept WhatsApp ban risk at pairing, recorded as a versioned Attestation, so that the risk was named and accepted, not buried. **(new — currently a disclosure gate with no stored Attestation)**
9. As an Account holder, I want to pair my own WhatsApp number by scanning a code, so that WALAO can receive my Group messages.
10. As a beta Account holder, I want to pair a dedicated test number rather than my primary one, so that platform risk stays off my real account.
11. As an Account holder, I want to see my WhatsApp Session's health — pending, connected, disconnected, re-pair required — so that I know whether my Summaries are complete.
12. As an Account holder, I want to disconnect my WhatsApp Session at any time, so that WALAO stops receiving anything immediately.
13. As an Account holder whose Session has had no enabled Group and no login for 14 days, I want it retired to re-pair-required rather than held open indefinitely, so that idle sessions don't consume the shared gateway's capacity (ADR-0001). **(new)**
14. As an Account holder whose Session was evicted, I want to be told why and be able to pair again, so that eviction is a recoverable state, not a dead end. **(new)**

### Groups & Attestation

15. As an Account holder, I want every Group off by default and enabled only one at a time by me, so that only Groups I chose are ever processed.
16. As an Account holder, I want enabling a Group to require a versioned Attestation that I am responsible for it, so that accountability is recorded per Group at the moment it starts.
17. As an Account holder, I want enabling a Group and recording its Attestation to happen atomically, so that a Group can never be processed without the affirmation that authorised it.
18. As an Account holder, I want messages from a Group I have not enabled to never enter the processing layer at all, so that my selection is a hard boundary rather than a downstream filter.
19. As an Account holder, I want a one-tap disclosure template I can post into a Group — nudged, never forced — so that telling the other members is easy.
20. As an Account holder, I want to see every Attestation I have made with its version and date, so that I can audit my own consent trail.
21. As an Operator, I want every Attestation stored with the exact version of the wording shown, so that the consent basis is provable before paid launch.
22. As an Account holder, I want disabling a Group to stop processing immediately and be recorded, so that turning it off is as auditable as turning it on.

### Group Members

23. As a Group Member who holds no Account, I want my messages retained only within the Account holder's retention window, so that being in a Group with a WALAO user carries bounded exposure.
24. As a Group Member, I want my messages never used to train models, so that my words don't leave the purpose they were collected for.
25. As a Group Member, I want no Operator to be able to read what I wrote, so that "the vendor can't read your messages" is true for me too, not only for their customer.
26. As an Account holder, I want it stated plainly that the Group Members' data is processed on my instruction and under my responsibility, so that I understand what I took on when I enabled the Group.

### Processing Block

27. As an Account holder, I want one clear answer to "is WALAO processing my messages right now?", so that I never have to reason about several overlapping statuses. **(new — the reasons exist, the single question does not)**
28. As an Account holder, I want the reason shown when processing is blocked — paused, unpaired, disconnected, unpaid, halted or over my Plan's daily cap — so that I know what to fix. **(new)**
29. As an Account holder, I want every part of the pipeline to honour the same Processing Block — ingestion, summarisation, delivery and outbound alike — so that a block is a real stop, not a partial one. **(new)**
30. As an Account holder, I want to pause and resume processing myself, so that I keep a hand on the switch.
31. As an Account holder, I want a period under a Processing Block to open a Coverage Gap, so that Summaries spanning it are flagged incomplete rather than presented as whole.

### Schedules & Summaries

32. As an Account holder, I want to set summary time, timezone and output language per Group, so that Summaries arrive when and how I want them.
33. As an Account holder, I want the schedule stored as local time plus timezone rather than UTC, so that the fire time tracks DST instead of drifting an hour twice a year.
34. As an Account holder, I want each Summary to carry highlights, decisions, action items, dates, open questions and memory candidates, so that I get outcomes rather than a chat replay.
35. As an Account holder, I want every Item in a Summary to carry references to the messages it came from, so that I can verify any claim against the original.
36. As an Account holder, I want a quiet window to produce "nothing happened", so that WALAO never invents content to fill a Summary.
37. As an Account holder, I want the Summary written in the Group's chosen output language regardless of the input language mix, so that mixed-language Groups still read cleanly.
38. As an Account holder, I want the model to say it doesn't know rather than invent a name, owner, date or decision, so that I can trust what it does state.
39. As an Operator, I want model, prompt version, token usage and generation time recorded per Summary with no message text in routine logs, so that quality and cost are traceable without new exposure.
40. As an Account holder, I want no Summary generated when a Group produced no new messages, so that I am not charged a Credit for nothing.

### Items

41. As an Account holder, I want to mark any Item complete or dismissed, so that the Summary drives action rather than only reading.
42. As an Account holder, I want to jump from an Item back to the Group it came from, so that acting on it is one step.
43. As an Account holder, I want Item state to persist across Today Briefs, so that something I already handled doesn't keep asking for attention.

### Today Brief & delivery

44. As an Account holder, I want one Today Brief that merges my Groups' Summaries and ranks them into needs action, decided and worth noting, so that a single glance covers the day.
45. As an Account holder, I want duplicate Items across Groups collapsed into one Item that keeps every source, so that the same decision doesn't appear five times.
46. As an Account holder, I want the Today Brief delivered into my own WhatsApp chat with myself, so that I read it where I already live.
47. As an Account holder, I want my Today Brief never posted into any source Group, so that my private digest stays private.
48. As an Account holder, I want in-app history of past Today Briefs and Summaries, so that I can review previous days.
49. As an Account holder, I want a delivery attempted exactly once per Summary, so that a retry never double-posts into my chat.

### Coverage Gaps

50. As an Account holder, I want a stretch when my Session was not connected recorded as a Coverage Gap, so that the hole is a fact in the system rather than an absence I have to notice.
51. As an Account holder, I want any Summary or Today Brief overlapping a Coverage Gap flagged incomplete, so that I never trust a silently truncated Summary.
52. As an Account holder, I want a product-wide halt to open a Coverage Gap for my Session too, so that the same honesty applies when the outage is WALAO's rather than mine.
53. As an Account holder, I want a Coverage Gap closed only by the condition that opened it, so that a halt ending doesn't hide the fact that my own Session is still down.

### Reminders

54. As an Account holder, I want to explicitly confirm an action Item before it becomes a Reminder, so that Group text alone never triggers anything on my behalf.
55. As an Account holder, I want a Reminder to carry owner, due date and status, so that a follow-up doesn't get lost.
56. As an Account holder, I want a confirmed Reminder to outlive the Summary it came from, so that the ~90-day Summary window doesn't quietly delete my commitments.
57. As an Account holder, I want to mark a Reminder done or dismissed, so that the list stays true.

### Memories

58. As an Account holder, I want Summaries to propose memory candidates, so that durable facts surface without me curating chats.
59. As an Account holder, I want candidates to expire unless I confirm them, so that nothing becomes permanent on the model's judgement alone.
60. As an Account holder, I want each Memory to show its content, source, creation time, confirmer and last-used time, so that I can audit why WALAO knows something.
61. As an Account holder, I want to view, edit, export and delete any Memory, so that long-term memory stays wholly mine.
62. As an Account holder, I want a confirmed Memory to outlive its source Summary, so that a durable fact isn't lost to the Summary retention window.
63. As an Account holder, I want my Memories to survive Cancellation, so that returning to Free never costs me what I already curated. **(new — Cancellation does not exist yet)**
64. As an Account holder, I want a weekly review of decisions, overdue Items and recurring risks, so that I catch what daily Briefs alone miss.

### Ask WALAO

65. As an Account holder, I want to ask questions in natural language about what my Groups decided, so that I retrieve outcomes without scrolling.
66. As an Account holder, I want every answer grounded in cited sources from Groups I enabled, so that answers are verifiable and scoped to what I authorised.
67. As an Account holder, I want verbatim quotes only while the original messages are inside my retention window, and paraphrase from Summaries beyond it, so that answers respect the retention I chose.
68. As an Account holder, I want a clear "I don't know" when my own data doesn't support an answer, so that low confidence is never dressed up as fact.

### Privacy & data control

69. As an Account holder, I want to set raw message retention between 1 and 30 days, defaulting to 7, so that storage matches my comfort level.
70. As an Account holder, I want raw messages encrypted at rest and deleted at expiry, so that "store less by default" is enforced rather than promised.
71. As an Account holder, I want my message bodies encrypted with a key that belongs to my Account alone, so that my data's fate is not tied to every other Account's (ADR-0002). **(new)**
72. As an Account holder, I want deleting my Account to destroy my key, so that my rows become undecryptable everywhere they still exist — including in a backup nobody can rewrite (ADR-0002). **(new)**
73. As an Account holder, I want to export everything WALAO holds about me, so that leaving costs me nothing.
74. As an Account holder, I want to delete a single Group's data or my whole Account, so that I keep exit rights at all times.
75. As an Account holder, I want an audit event for every privacy action, containing no message body, so that operations are provable without new exposure.
76. As an Account holder, I want the delete-account audit event to outlive the Account, so that the deletion itself remains provable.
77. As an Account holder, I want to know that WALAO runs in Singapore and that summarisation sends message text to Anthropic outside the region, so that I am deciding on the real architecture rather than a marketing claim (ADR-0003). **(new — disclosure text and its Attestation)**

### Security & isolation

78. As an Operator, I want webhook ingress to enforce HMAC verification, a freshness window and idempotency on session plus message id, so that forged or replayed events are rejected.
79. As an Operator, I want every query and background job scoped to one Account, so that cross-Account leakage is structurally impossible rather than merely untested.
80. As an Operator, I want Group text treated as untrusted data and the summariser to hold no tool access, so that prompt injection cannot cause an action.
81. As an Operator, I want WALAO's own outbound echoes excluded at ingress, so that deliveries never loop back into Summaries.
82. As an Operator, I want the gateway's SQLite credential store treated as the single highest-value asset in the system, so that its protection is a named responsibility rather than an assumption (ADR-0001).
83. As an Account holder, I want a webhook for a session that isn't mine to be incapable of writing to my Account, so that the gateway being shared is invisible to my data.

### Gateway policy & platform risk

84. As a Tier 0 Account holder, I want WALAO restricted to reading enabled Groups and messaging myself, so that my ban risk stays low by default.
85. As a Tier 1 Account holder, I want to explicitly authorise outbound messages to others with a versioned Attestation, so that the choice and its consequences are explicitly mine.
86. As a Tier 1 recipient, I want to reply "Yes" before any further message reaches me, so that WALAO never becomes a spam channel.
87. As an Operator, I want a product-wide halt switch for a WhatsApp or Meta legal notice, so that the shutdown path is decided before it is needed.
88. As an Operator, I want the halt to stop pairing, ingestion, delivery and outbound alike, so that "halted" means the gateway is genuinely quiet.
89. As an Operator, I want the gateway behind an adapter with WALAO owning its own data model, so that the provider can be replaced without touching Summaries, Memories or permissions.
90. As an Operator, I want the shared gateway's blast radius stated plainly — one crash takes every Account offline — so that the operational risk is budgeted rather than discovered (ADR-0001).

### Plan, Credit, Trial & Cancellation

91. As an Account holder, I want a named Plan — Free or Pro — that fixes my caps on enabled Groups, daily messages and daily Credits, so that what I get is legible before I pay.
92. As an Account holder, I want usage counted in Credits where one Credit is one AI-generated Group Summary, so that cost is legible without me learning what a token is.
93. As an Account holder, I want Credits to be a measurement rather than a balance, so that I never have to buy, bank or top up anything.
94. As an Account holder, I want per-Group Credit burn visible, so that I can spot and mute an expensive Group.
95. As an Account holder, I want hitting my daily message cap to block processing with a stated reason rather than silently drop messages, so that a cap feels like a limit rather than a bug.
96. As an Account holder, I want a 14-day Trial with Pro's caps starting when I pair, requiring no card, so that I can evaluate the product on my real Groups. **(new)**
97. As an Account holder, I want the Trial granted once per WhatsApp number rather than once per Account, so that the offer is honest and not farmable by re-signup. **(new)**
98. As an Account holder, I want my Trial's remaining days visible, so that expiry is never a surprise. **(new)**
99. As an Account holder whose Trial ended, I want to fall back to Free's caps rather than lose access, so that expiry degrades the service instead of ending it. **(new)**
100. As an Account holder, I want Cancellation to mean returning to the Free Plan, so that stopping payment is never confused with deleting my data. **(new)**
101. As an Account holder who cancelled, I want my Summaries, Memories and Reminders to survive intact, so that I keep everything I already made. **(new)**
102. As an Account holder who cancelled, I want my enabled Groups to stay enabled but blocked above Free's cap rather than be silently disabled, so that upgrading again restores exactly what I had. **(new)**
103. As an Account holder over my Plan's Group cap, I want the Groups that keep running chosen by a stated rule rather than at random, so that I can predict and change which ones are blocked. **(new)**
104. As an Account holder, I want an unpaid Pro Account to be a Processing Block with a clear reason, so that a billing problem is visible and fixable rather than mysterious. **(new)**

### Operator

105. As an Operator, I want to see an Account's metadata — counts, job status, connection history, token usage — so that I can support and run the product.
106. As an Operator, I want to be structurally unable to read a message or Summary body, so that the privacy promise does not depend on my restraint. **(new — the review queue currently exposes Summary bodies with no opt-in)**
107. As an Account holder, I want to opt in before any Operator can read my Summaries for quality review, so that the one exception to that rule is mine to grant. **(new)**
108. As an Operator, I want operator actions authenticated separately from Account credentials, so that operator access is never reachable with a customer token.
109. As an Operator, I want to change an Account's Plan directly, so that upgrades work before payment integration exists.

### Quality operations

110. As the product owner, I want a weekly human review of Malay Summaries from opted-in Accounts, so that the weakest language lane has a named quality owner.
111. As the product owner, I want a weekly accuracy, omission and privacy-event review during beta, so that expansion gates on evidence rather than enthusiasm.
112. As the product owner, I want quality review records to survive deletion of the Summary or the Account they concerned, so that the quality trail is not erased by ordinary data lifecycle.
113. As the product owner, I want at most one Malay review per Summary, so that the review counts are a real denominator.

## Implementation Decisions

### Language and naming

- `CONTEXT.md` is the authoritative glossary. Its terms — Account, WhatsApp Session, Group, Group Member, Attestation, Processing Block, Operator, Summary, Item, Today Brief, Coverage Gap, Reminder, Memory, Plan, Credit, Trial, Cancellation — are used in the API, in domain types, in user-facing copy and in new code. The listed _Avoid_ terms do not appear in any of those.
- Physical database names stay as they are: the `users` table and the `user_id` column continue to mean Account. Renaming them cascades through 15 migrations, 12 tables and every query for zero behaviour change. The mapping is documented here and in `CONTEXT.md`; the rename is available later as one mechanical migration if the mismatch starts costing more than the churn would.
- Where a name is being introduced or an endpoint added, it uses the glossary term with no legacy alias.

### Account & identity

- The `users` row gains `email` (unique, citext), `email_verified_at`, and keeps `api_token_sha256` as the credential the API accepts. Signup issues a verification code by email; verifying issues the bearer token. No password — the mail round trip is the factor, and a password store is work the product does not need yet.
- An Account is fully usable before pairing: Plan, terms Attestation, and the disclosure copy are all reachable with no WhatsApp Session.
- New endpoints: `POST /v1/signup`, `POST /v1/verify`, `POST /v1/login`.

### Attestation

- `consent_records` generalises into `attestations`: `(id, user_id, kind, version, group_id nullable, created_at)` with `kind ∈ ('data_processing_terms', 'ban_risk', 'group_responsibility', 'tier1_outbound')`. Group enable/disable audit rows keep their existing shape and reference the Attestation that authorised the enable.
- `users.tier1_authorization_version` is replaced by a `tier1_outbound` Attestation row. `tier1_enabled_at` stays as the fast lookup.
- Enabling a Group and writing its `group_responsibility` Attestation happen in one transaction. This invariant is already enforced and must survive the table generalisation.
- `GET /v1/attestations` replaces `GET /v1/consent-records`.

### Processing Block

- One module owns the question: `processingBlock(db, accountId) → { reason } | null` with `reason ∈ ('paused', 'unpaired', 'disconnected', 'unpaid', 'halted', 'over_daily_messages', 'over_daily_credits', 'over_group_cap')`. `over_group_cap` is evaluated per Group; the rest are per Account.
- Every existing scattered check routes through it: the ingestion consumer's session-status, paused and plan-limit checks; the halt gate in the HTTP layer; the delivery and outbound guards. Callers get a reason, never a boolean, so the API can always say why.
- `GET /v1/status` returns the current block or `null`, plus the Session's health and the open Coverage Gap if there is one. The app renders this as the single "is WALAO working" answer.
- Opening a block that represents lost coverage (`disconnected`, `halted`, `paused`) opens a Coverage Gap; clearing it closes exactly the gap it opened. This behaviour already exists for halt and disconnect and generalises.
- `unpaid` is a column on the Account set by an Operator. Payment integration is out of scope; the block exists so the pipeline understands the state before a payment provider does.

### Per-Account envelope encryption (ADR-0002)

- Each Account gets a random 32-byte data key at creation, stored on its row as `data_key_wrapped bytea`, wrapped with `WALAO_ENC_KEY` using the existing AES-256-GCM primitive.
- `encrypt`/`decrypt` keep their current signature — they take a key. What changes is the caller: the key comes from `accountKey(db, accountId)`, not from config. The key is unwrapped once per request or job and cached for its lifetime, never per row.
- Account deletion deletes the wrapped key. Deletion of an Account's rows still happens; the key destruction is what makes rows in an unrewritable backup undecryptable.
- Master-key rotation rewraps N key rows. It does not touch `messages`.
- Any future feature that copies plaintext out of `messages` — a search index, an export cache, a log line — breaks this guarantee. That constraint is recorded here and in ADR-0002 because it is invisible at the call site.
- Migration: existing rows are re-encrypted under their Account's new key in one pass. Dev-scale data only; a production-scale rewrite is not in play at this stage.

### Trial

- New table `trials`: `(id, user_id, number_sha256, started_at, ends_at)` with a unique index on `number_sha256` — the grant is once per WhatsApp number, so a re-signup with the same number gets no second Trial. Only the hash is stored.
- The Trial starts when pairing completes, runs 14 days, needs no card, and grants Pro's caps for its duration. Plan resolution becomes: active Trial → Pro caps; otherwise the Account's `plan`.
- `GatewayPort` gains the paired number: the connected status event carries it, or `sessionNumber(sessionExternalId)` fetches it. The adapter hashes it before it reaches storage.
- Trial state is visible in `GET /v1/usage`.

### Plan, Credit & Cancellation

- Plans and their caps stay where they are: Free (3 Groups, 500 messages/day, 5 Credits/day) and Pro (20, 5000, 50). A Credit remains derived by counting Summaries with a real model — no ledger table, so deleting a Group's data deletes its billing trail with it.
- `POST /v1/plan/cancel` sets the Plan to Free. It deletes nothing. Summaries, Memories and Reminders are untouched, and Groups stay enabled.
- Over the Group cap, the Groups that keep processing are the N enabled longest; the remainder carry an `over_group_cap` Processing Block until the Account disables enough Groups or upgrades. Nothing is auto-disabled — the rule is deterministic and reversible.

### Session eviction (ADR-0001)

- A periodic job flips any Session with no enabled Group and no Account login for 14 days to `re_pair_required` and opens a Coverage Gap for it. The reason is surfaced through `GET /v1/status` so re-pairing is an obvious next step.
- Eviction exists because one process holds every Account's Session; it is a capacity control, not a punishment, and the copy says so.

### Operator boundary

- Operator endpoints return metadata only. The one exception is the Malay quality review queue, which requires `quality_review_opt_in` on the Account; Summaries from Accounts that have not opted in never appear in it.
- Operator authentication stays a separate secret header, never an Account token.

### Residency & disclosure (ADR-0003)

- Production runs in ap-southeast-1. The privacy policy names the region and states that summarisation sends message text to Anthropic outside it. The `data_processing_terms` Attestation version tracks that wording, so a change to the disclosure is a new version rather than a silent edit.
- The PDPA transfer basis rests on safeguards already decided: per-Account encryption at rest, no Operator access to bodies, no use of merchant data for training.

### Architecture (unchanged from v1, restated)

- Gateway adapter → HMAC-verified webhook ingress → durable queue → normaliser → encrypted store → scheduler and summary jobs → AI processing → app and delivery. A privacy service enforces retention, deletion, export, Attestation and audit.
- `GatewayPort` is the replaceable provider boundary; nothing above it depends on WAAPI's schema. Known provider gaps to design around: no history import, an in-memory webhook dispatcher that can drop events (WALAO owns durable ingress and gap detection), a `has_media` flag only, reactions unverified.
- `SummarizerPort` is the AI boundary: message batch plus config in, structured JSON out, no tool access. Fact extraction precedes prose; every claim needs at least one valid source reference or it is dropped; uncertainty is marked, never filled in.
- The Summary output contract is unchanged and remains the decision:

  ```json
  {
    "highlights": [{"text": "...", "source_message_ids": ["..."]}],
    "decisions": [{"text": "...", "source_message_ids": ["..."]}],
    "action_items": [{"text": "...", "owner": null, "due_at": null, "confidence": 0.0, "source_message_ids": ["..."]}],
    "dates": [], "open_questions": [], "memory_candidates": []
  }
  ```

- PostgreSQL only. Full-text search for Ask WALAO; pgvector only when real Q&A tests prove a semantic-retrieval gap.
- Retention: raw messages 1–30 days per Account (default 7), Summaries ~90 days, confirmed Memories and Reminders until deleted.
- Delivery is WhatsApp-first into the Account's own chat with itself; the app is the surface for history, settings and Ask WALAO.

### API surface after this spec

Added: `/v1/signup`, `/v1/verify`, `/v1/login`, `/v1/status`, `/v1/plan/cancel`, `/v1/attestations` (replacing `/v1/consent-records`). Trial state joins `/v1/usage`. Everything else keeps its current path. All writes carry auth, authorisation, validation, idempotency and audit. The app never calls the gateway directly.

## Testing Decisions

A good test here asserts **external behaviour only**: given events in and time advancing, what went out through the gateway, what the API returned, and what remains in or is gone from storage. No test reaches into module internals or asserts on an intermediate representation. A test that would still pass if the feature were reimplemented differently is the target.

### Seams

No new seam is introduced. The three that exist carry all of this work.

1. **Whole-system seam (primary)** — `makeHarness()` in `test/helpers.ts`: real Postgres, real HTTP, real HMAC ingress, with `FakeGateway`, `FakeSummarizer` and `FakeAnswerer` at the ports and an operator entry point via `op()`. Assertions land on `gateway.sends` / `gateway.recipientSends` and on API responses. Every new behaviour in this spec is observable here — signup and login, the Processing Block reason, Trial grant and expiry, Cancellation leaving data intact, Session eviction, and crypto-shredding after account deletion.
2. **AI-pipeline seam** — message batch plus config in, structured JSON out. Carries the extraction contract: source-reference validity, no invention on quiet input, "I don't know", prompt-injection resistance, language routing.
3. **Scheduler seam** — schedule config plus clock in, job emissions out. Carries timezone correctness, DST edges, local-time semantics and the no-op on no new messages.

### Time

Time-dependent behaviour is tested by **backdating seeded rows**, not by injecting a clock. A Trial ending is a `trials` row seeded 15 days back; an idle eviction is a Session seeded with an old `status_changed_at` and no login. This is the pattern `seedMessage` and `seedSummary` already use with explicit timestamps, and it keeps the number of seams at three. If a future behaviour needs several times to move in one test, injecting a `now()` into config is the upgrade path.

### Prior art

`test/tenant-isolation.test.ts` is the model for the isolation assertions; `test/privacy.test.ts` for deletion and export; `test/halt.test.ts` for the gap-opening pattern that the Processing Block generalises; `test/billing.test.ts` for cap enforcement, which Trial and Cancellation extend. New behaviour gets new files alongside these — account identity, processing block, trial, cancellation, envelope encryption, session eviction — rather than being appended to existing suites.

### Invariants that get dedicated tests at the whole-system seam

- Zero cross-Account leakage and zero unauthorised Groups processed — the two zero-tolerance metrics.
- A Group cannot be enabled without an Attestation written in the same transaction.
- Message bodies from Account A cannot be decrypted with Account B's key, and no body is decryptable after A's key is destroyed.
- Every pipeline stage refuses to run under a Processing Block, and each block reason surfaces through the API.
- Cancellation deletes nothing: Summaries, Memories and Reminders survive and Groups stay enabled.
- A second Account pairing an already-trialled number gets no Trial.
- No Operator response contains a message or Summary body except the review queue, and that queue contains only opted-in Accounts' Summaries.

## Out of Scope

- Payment collection and any payment provider integration. Plan changes are Operator actions; `unpaid` is a state the pipeline understands, not one a card triggers.
- Passwords, SSO, multi-user Accounts, and any team or admin console.
- Renaming the physical `users` table and `user_id` columns.
- Historical message import from before pairing.
- Image, voice, video and document understanding — text only.
- Zero-knowledge claims or architecture. Message text reaches Anthropic; that is disclosed, not engineered away.
- pgvector or a dedicated vector store, gated on a measured retrieval gap.
- Official Meta WhatsApp Business Platform integration — a separate capability review.
- Sharded gateway pools and a `gateway_nodes` routing table. The single-process ceiling is accepted; ADR-0001 records the upgrade path.
- Automatic ban-wave tripwire — manual judgement per the accepted residual risk.
- Calendar integration, audio briefs, and any surface beyond app plus note-to-self delivery.

## Further Notes

- This spec is a full restatement, not a diff. The unmarked stories are the regression contract for behaviour already shipped through ticket 16; the **(new)** stories are the work.
- The largest single risk in the new work is envelope encryption: it touches every read path for message bodies, and a missed call site fails open by decrypting nothing rather than by leaking, so the failure mode is loud. Sequence it before Trial and Cancellation, which are additive.
- The Processing Block refactor should land before the commerce work, since Trial, Cancellation and `over_group_cap` all express themselves through it. Doing commerce first means writing those checks twice.
- The shared gateway's SQLite file holds every Account's WhatsApp credentials. Nothing in this spec changes that; it remains the highest-value asset in the system and the reason ADR-0001's blast radius is stated in the stories rather than buried in an ADR.
- The gateway's webhook dispatcher can drop events under load. Durable ingress plus gap detection is the compensation, and "incomplete" must stay a first-class visible state.
- This document is not legal advice. PDPA review and WhatsApp ToS review gate commercial launch.
- The README is bilingual; this spec is EN-only as an internal engineering document.
