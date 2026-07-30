# 13 — Tier 1 outbound opt-in with recipient handshake

**What to build:** A user can explicitly opt in to Tier 1: authorizing WALAO to send outbound messages to others, with the platform risk explicitly accepted as theirs. The first message to any recipient requests consent; further messages to that recipient continue only after the recipient replies "Yes". Without opt-in, the Tier 0 boundary (read + note-to-self only) stays enforced.

**Blocked by:** 07 — Note-to-self delivery.

**Status:** ready-for-agent

- [ ] Tier 1 requires an explicit opt-in step that records the user's risk acceptance
- [ ] A non-opted-in user's outbound attempts to third parties are rejected at the boundary
- [ ] First outbound to a new recipient is a consent request; subsequent messages are blocked until a "Yes" reply is ingested
- [ ] Recipient's "Yes" state is per-recipient and revocable; post-revocation messages are blocked
