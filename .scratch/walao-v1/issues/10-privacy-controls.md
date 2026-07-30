# 10 — Privacy controls: pause, export, delete

**What to build:** The user can pause processing, export their data, delete a single group's data, or delete their whole account. Deletion propagates to primary storage, caches, indexes, and controllable backups — deleted means deleted, proven by tests. Every privacy action emits an audit event that never contains message bodies, so operations are provable without new exposure.

**Blocked by:** 02 — Group subscriptions & consent; 04 — Raw retention & expiry.

**Status:** ready-for-agent

- [ ] Pause stops all processing (ingestion continues per design decision or is halted — behavior defined and tested)
- [ ] Export produces the user's data in a portable format covering messages within retention, summaries, and settings
- [ ] Group-level delete removes that group's messages, summaries, and derived data; whole-account delete removes everything
- [ ] Post-deletion, no trace remains in primary storage, caches, or search indexes (whole-system verification)
- [ ] Each privacy action produces an audit event with actor, action, and timestamp but no message content
