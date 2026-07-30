# 04 — Raw retention & expiry

**What to build:** The user sets one global raw-message retention period between 1 and 30 days (default 7). Raw messages are stored encrypted with an expiry, and are automatically and verifiably deleted when the window passes — "store less by default" enforced by the system, not promised by policy.

**Blocked by:** 01 — Walking skeleton.

**Status:** ready-for-agent

- [ ] Retention setting is one global value per user, clamped to 1–30 days, defaulting to 7
- [ ] Advancing a controlled clock past a message's expiry removes the raw message from storage (whole-system test)
- [ ] Changing the retention setting applies to subsequently stored messages; behavior for existing messages is defined and tested
- [ ] Non-user group members' messages are equally bounded by the retention window
