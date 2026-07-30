# 01 — Walking skeleton: webhook event → encrypted stored message → visible via API

**What to build:** A synthetic gateway webhook event submitted to WALAO is verified (HMAC signature, freshness window, idempotency on session + message id), flows through a durable queue and normalizer into an encrypted PostgreSQL store, and is visible through an authenticated, tenant-scoped API read. Forged, stale, or replayed events are rejected and leave no trace. This establishes the whole-system test seam (fake GatewayPort, real PostgreSQL) and the house testing style: assert only on external behavior — API responses and storage outcomes.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] A valid webhook event ends up as an encrypted message row visible via the API for its owning user only
- [ ] Events with bad HMAC, expired freshness, or duplicate session+message id are rejected; duplicates are idempotent (no double-store)
- [ ] All queries are tenant-scoped; a second user can never read the first user's message (dedicated zero-tolerance test)
- [ ] Ingestion survives a queue-consumer restart without losing the event (durable, not in-memory — this compensates for the gateway's lossy dispatcher)
- [ ] Whole-system test seam runs against real PostgreSQL with a fake GatewayPort; no test reaches into internal module state
