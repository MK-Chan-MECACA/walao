# WALAO v1 Spec — Sprints 1–5 (Ingestion → Memory Beta)

> Status: `ready-for-agent` (label recorded here — no issue tracker configured yet; run `/setup-matt-pocock-skills` to migrate)
> Source: README v0.4 (2026-07-26) + confirmed product decisions of 2026-07-30 (README §19)
> Excludes: Sprint 0 feasibility spike (tracked separately; blocked on test SIM + gateway deployment target)

## Problem Statement

Busy WhatsApp groups produce hundreds of messages a day, but a user only needs a handful of outcomes: what was decided, what needs their reply, which dates and payments were mentioned, and what matters but can wait. Notifications only say "something is new" — they never say what deserves attention. Users lose 30–60 minutes a day scrolling, still miss decisions and deadlines, and cannot retrieve an old decision without re-reading hundreds of messages.

## Solution

WALAO is a personal AI information layer on top of WhatsApp. The user pairs their own WhatsApp account, explicitly enables specific groups, and at a scheduled time receives a Today Brief — decisions, action items, dates, and open questions, each with traceable sources — delivered to their own "Message Yourself" chat and viewable in the WALAO app. The user can ask questions over approved data (Ask WALAO), confirm distilled facts into long-term memory, and control retention, export, and deletion at all times. WhatsApp stays the execution layer; WALAO is the intelligence layer. The gateway is a replaceable adapter, never the product.

## User Stories

### Onboarding & connection
1. As a new user, I want to create a WALAO account and see a plain-language explanation of data use, retention, AI providers, and unofficial-gateway risk, so that I consent with full knowledge before anything is processed.
2. As a new user, I want to pair my own WhatsApp account via QR or pairing code, so that WALAO can receive my group messages.
3. As a beta user, I want to pair a dedicated test number instead of my primary number, so that platform-risk stays off my real account.
4. As a user, I want to see my connection health (connected / disconnected / re-pair required), so that I know whether my briefs are complete.
5. As a user, I want WALAO to clearly flag a brief as incomplete when the gateway was disconnected during the window, so that I never trust a silently truncated summary.
6. As a user, I want to disconnect my WhatsApp session at any time, so that WALAO stops receiving anything immediately.

### Group selection & consent
7. As a user, I want to enable or disable groups individually with everything off by default, so that only groups I chose are ever processed.
8. As a user, I want to self-attest responsibility for each group I enable, so that consent accountability is recorded per group.
9. As a user, I want a one-tap disclosure template I can post into a group (nudged, not forced), so that informing members is easy.
10. As a compliance stakeholder, I want every attestation event logged with version and timestamp, so that the consent basis is auditable before paid launch.
11. As a user, I want messages from disabled groups to never enter WALAO's processing layer, so that my group selection is a hard boundary, not a filter.

### Schedules & summaries
12. As a user, I want to set summary time, timezone, and language per group, so that briefs arrive when and how I want them.
13. As a user, I want each summary to extract highlights, decisions, action items, dates, and open questions, so that I get outcomes rather than a chat replay.
14. As a user, I want every summary item to carry source-message references, so that I can verify any claim against the original messages.
15. As a user, I want quiet groups to produce no invented content, so that WALAO says "nothing happened" instead of hallucinating a summary.
16. As a user, I want summaries generated in my chosen output language (Chinese, English, or Malay) regardless of the input language mix, so that mixed-language groups still produce readable briefs.
17. As a user, I want the model to say "I don't know" rather than invent names, owners, dates, or decisions, so that I can trust what it does state.
18. As the product owner, I want model, prompt version, token usage, and generation time recorded per summary (with no raw chat in routine logs), so that quality and cost are traceable.

### Today Brief & delivery
19. As a user, I want a combined Today Brief that ranks items across all my groups into "needs action", "decided", and "worth noting", so that one glance covers everything important.
20. As a user, I want duplicate items across groups merged while keeping all sources visible, so that the same decision doesn't appear five times.
21. As a user, I want the Today Brief delivered to my own "Message Yourself" WhatsApp chat, so that I read it where I already live.
22. As a user, I want my personal brief never posted back to any source group, so that my private digest stays private.
23. As a user, I want in-app history of past briefs and summaries, so that I can review previous days.
24. As a user, I want to mark items complete, dismiss them, or jump back to WhatsApp from any item, so that the brief drives action, not just reading.

### Reminders & actions
25. As a user, I want to confirm an extracted action item before it becomes a reminder, so that group text alone never triggers anything on my behalf.
26. As a user, I want action items to track owner, due date, and status, so that follow-ups don't get lost.

### Ask WALAO
27. As a user, I want to ask natural-language questions like "what did the purchasing group decide yesterday?", so that I retrieve outcomes without scrolling.
28. As a user, I want every answer grounded in cited sources from groups I approved, so that answers are verifiable and scoped to my authorization.
29. As a user, I want verbatim quotes only while originals are within my raw-retention window, and paraphrases from summaries beyond it, so that answers respect my retention settings.
30. As a user, I want a clear "I don't know" when the approved data doesn't support an answer, so that low confidence is never dressed up as fact.

### Long-term memory
31. As a user, I want summaries to propose memory candidates (e.g. "Supplier A's payment term is 30 days"), so that durable facts surface without me curating chats.
32. As a user, I want candidates to expire automatically unless I confirm them, so that nothing becomes permanent by model judgment alone.
33. As a user, I want to view, edit, export, and delete any confirmed memory, so that long-term memory stays fully mine.
34. As a user, I want each memory to show its content, source, creation time, confirmer, and last-used time, so that I can audit why WALAO knows something.
35. As a user, I want a weekly review of decisions, overdue items, and recurring risks, so that I catch what daily briefs alone miss.

### Privacy & data control
36. As a user, I want to set raw-message retention between 1 and 30 days (default 7, one global setting), so that storage matches my comfort level.
37. As a user, I want raw messages encrypted at rest and auto-deleted at expiry, so that "store less by default" is enforced, not promised.
38. As a user, I want to pause processing, export my data, and delete a group's data or my whole account, so that I keep exit rights at all times.
39. As a user, I want deletion to propagate to primary storage, caches, indexes, and controllable backups, so that deleted means deleted.
40. As a compliance stakeholder, I want audit events for privacy actions that never contain message bodies, so that operations are provable without new exposure.
41. As a group member who is not a WALAO user, I want my messages excluded from long-term storage beyond the retention window and never used to train models, so that being in a group with a WALAO user carries bounded exposure.

### Security & isolation
42. As the operator, I want webhook ingress to enforce HMAC verification, freshness windows, and idempotency on `session + message id`, so that forged or replayed events are rejected.
43. As the operator, I want every query and background job tenant-scoped, so that cross-user leakage is structurally impossible, not merely untested.
44. As the operator, I want group text treated as untrusted data with the summary model holding no tool access, so that prompt injection cannot trigger actions.
45. As the operator, I want `from_me` system echo messages excluded from processing, so that WALAO's own deliveries never loop into summaries.

### Gateway policy & platform risk
46. As a Tier 0 user, I want WALAO restricted to reading enabled groups and messaging myself, so that my ban risk stays low by default.
47. As a Tier 1 opt-in user, I want to explicitly authorize outbound messages to others and accept the risk as mine, so that the choice and its consequences are explicitly mine.
48. As a Tier 1 recipient, I want to reply "Yes" before further messages continue, so that WALAO never becomes a spam channel.
49. As the product owner, I want a product-level halt switch triggered by a WhatsApp/Meta legal notice, so that the shutdown path is decided before it's needed.
50. As the product owner, I want the gateway behind an adapter with WALAO owning its own data model, so that WAAPI can be replaced without touching summaries, memory, or permissions.

### Pricing & usage
51. As a user, I want usage billed as credits (~1 credit ≈ 1 daily group summary), never raw tokens, so that costs are legible.
52. As a user, I want per-group credit burn visible, so that I can mute expensive groups.
53. As the operator, I want visible plan limits on groups, message volume, and AI usage, so that costs stay bounded per plan.

### Quality operations
54. As the product owner, I want weekly human review of Malay summaries (interim: product owner; transfers to a Malay-primary beta user once recruited), so that the weakest language lane has a named quality owner.
55. As the product owner, I want weekly accuracy/omission/privacy-event review during beta, so that expansion gates on evidence, not enthusiasm.

## Implementation Decisions

- **Architecture** (README §9): Gateway adapter → HMAC-verified webhook ingress → durable queue → normalizer → encrypted operational store → scheduler + summary jobs → AI processing → app + notification service. Privacy service enforces retention, deletion, export, consent, audit.
- **GatewayPort** is the replaceable boundary: converts provider sessions, JIDs, webhooks, and send APIs into WALAO's internal format. WAAPI Gateway is the prototype implementation only; nothing above the adapter may depend on WAAPI's schema. Known WAAPI gaps to design around: no history import, in-memory webhook dispatcher that can drop events (WALAO owns durable ingress + gap detection), `has_media` flag only (text-only MVP), reactions unverified.
- **SummarizerPort** is the AI boundary: message batch + config in, structured JSON out. The summarizer holds no tool access. Fact extraction precedes prose generation; every claim requires ≥1 valid source or is dropped; uncertainty is marked, never filled in.
- **Summary output contract** (from README §11 — this schema is the decision):

  ```json
  {
    "highlights": [{"text": "...", "source_message_ids": ["..."]}],
    "decisions": [{"text": "...", "source_message_ids": ["..."]}],
    "action_items": [{"text": "...", "owner": null, "due_at": null, "confidence": 0.0, "source_message_ids": ["..."]}],
    "dates": [], "open_questions": [], "memory_candidates": []
  }
  ```

- **Data model** (README §10): users, whatsapp_sessions, groups, group_subscriptions, messages (ciphertext + expiry), summary_schedules (local time + timezone, not UTC-only), summaries, summary_sources, action_items, memory_candidates, memories, consent_records, audit_events. Every query tenant-scoped.
- **Database**: PostgreSQL only. Full-text search for Ask WALAO; add pgvector only when real Q&A tests prove a semantic-retrieval gap.
- **API contract** (README §12): `/v1/connections`, `/v1/groups`, `/v1/groups/{id}/subscription`, `/v1/summary-schedule`, `/v1/briefs/today`, `/v1/summaries/{id}`, `/v1/ask`, `/v1/memories`, `/v1/privacy/export`, `/v1/privacy/delete`. All writes: auth, authz, validation, idempotency, audit. The app never calls the gateway directly.
- **Retention**: raw 1–30 days user-configurable (default 7, global per user); summaries ~90 days; confirmed memories until deleted. Ask WALAO quotes originals only inside the raw window.
- **Delivery**: WhatsApp-first via the user's own Message-Yourself chat (Sprint 2); app is the surface for history, settings, Ask WALAO (Sprint 3).
- **Gateway policy tiers**: Tier 0 default (read + note-to-self); Tier 1 opt-in outbound with recipient "Yes" handshake; legal notice from WhatsApp/Meta halts gateway product-wide. Accepted residual risks recorded in README §19.
- **Cost controls**: batch by group × window; deterministic cleaning before AI; small model for extraction, escalate only hard summaries; no-op when no new messages; briefs built from summaries, not raw text.
- **Languages**: ZH/EN/MS output at launch; mixed-language input handled automatically.
- **Sequencing**: Sprint 1 ingestion (HMAC, idempotency, durable queue, tenant mapping, encryption, expiry, health) → Sprint 2 summary MVP (schedule, extraction contract, citations, note-to-self delivery) → Sprint 3 Today Brief app (surfaces, privacy controls) → Sprint 4 Ask WALAO (grounded answers, authz filtering, low-confidence handling) → Sprint 5 Memory Beta (candidates, confirmation lifecycle, weekly review).

## Testing Decisions

Good tests here assert **external behavior only**: given events in and time advancing, what messages went out, what the API returns, what remains in (or is gone from) storage after expiry/deletion. No test may reach into internal module state or assert on intermediate representations.

Three seams (confirmed with product owner):

1. **Whole-system seam (primary)**: drive WALAO as a black box — synthetic gateway webhook events through a fake GatewayPort, canned structured JSON from a fake SummarizerPort, a controlled clock for the scheduler. Real PostgreSQL underneath; nothing else faked. Assert on outbound sends captured by the fake gateway and on API responses. This seam carries the safety-critical invariants: disabled-group messages never processed, tenant isolation, incomplete-brief flagging, deletion propagation, `from_me` exclusion, idempotent replay handling.
2. **AI-pipeline seam**: message batch + config in → structured summary JSON out. Tests the extraction contract in isolation: source-reference validity, no-invention on quiet input, "I don't know" behavior, prompt-injection resistance (hostile message text must not alter output structure or trigger anything), language routing.
3. **Scheduler seam**: schedule config + clock in → job emissions out. Tests timezone correctness, DST edges, local-time (not UTC-only) semantics, and no-op on no new messages.

No prior art exists — this is a greenfield repo; these tests establish the house style. Zero-tolerance metrics from README §16 (cross-tenant leaks: 0, unauthorized groups processed: 0) get dedicated tests at the whole-system seam, not just the lower seams.

## Out of Scope

- Sprint 0 feasibility spike (separate track; blocked on test SIM + gateway deployment target)
- Bulk marketing, cold outreach, or auto-replies on the user's behalf
- Historical message import before connection
- Image, voice, video, or document understanding (text-only; gateway exposes `has_media` flag only)
- Zero-knowledge claims or architecture
- pgvector / dedicated vector store (gated on measured retrieval gap)
- Official Meta WhatsApp Business Platform integration (separate capability review)
- Team/enterprise features: shared briefs, admin console, longer retention policies
- Calendar integration, audio briefs, AI Inbox, Action Center (post-v1 "Next" items beyond Sprint 5)
- Automatic ban-wave tripwire (manual judgment per accepted residual risk)

## Further Notes

- WAAPI Gateway integration was verified against commit `fa1c2fe` (2026-07-26); re-verify the webhook payload shape and the reaction-handler gap before Sprint 1 relies on either.
- The gateway's webhook dispatcher can drop events under load — WALAO's durable ingress plus sequence/time gap monitoring is the compensation, and "incomplete brief" must be a first-class visible state, never silent.
- This document is not legal advice; PDPA and WhatsApp ToS review gates commercial launch (README §18).
- Bilingual parity: the README is ZH+EN; this spec is EN-only as an internal engineering document.
