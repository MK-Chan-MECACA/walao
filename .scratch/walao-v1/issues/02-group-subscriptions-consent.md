# 02 — Group subscriptions & consent attestation

**What to build:** The user can list their groups and enable or disable each one individually, with everything off by default. Enabling a group requires a self-attestation of responsibility, recorded with attestation version and timestamp for audit. Messages from disabled groups never enter WALAO's processing layer — dropped at the boundary, not filtered later. The user also gets a one-tap disclosure template they can post into a group (nudged, never forced).

**Blocked by:** 01 — Walking skeleton.

**Status:** ready-for-agent

- [ ] Groups are listable per user; all disabled by default
- [ ] Enabling a group records a consent attestation event with version and timestamp; the audit trail is queryable
- [ ] A webhook event for a disabled group is dropped before processing and never stored (zero-tolerance test: unauthorized groups processed = 0)
- [ ] Disabling a previously enabled group immediately stops new messages from being stored
- [ ] Disclosure template is retrievable for the user to post; posting it is optional
