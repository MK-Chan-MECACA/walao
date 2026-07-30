# 12 — Memory beta: candidates, confirmation lifecycle, weekly review

**What to build:** Summaries propose memory candidates (e.g. "Supplier A's payment term is 30 days"). Candidates expire automatically unless the user confirms them — nothing becomes permanent by model judgment alone. Confirmed memories are viewable, editable, exportable, and deletable, each showing content, source, creation time, confirmer, and last-used time. A weekly review digest surfaces decisions, overdue items, and recurring risks that daily briefs miss.

**Blocked by:** 06 — Summary generation; 09 — App surfaces.

**Status:** ready-for-agent

- [ ] Memory candidates from summaries appear for user review with their source references
- [ ] An unconfirmed candidate expires after its window (controlled-clock test); a confirmed one persists until deleted
- [ ] Confirmed memories are listable, editable, exportable, and deletable via the API and app
- [ ] Each memory exposes content, source, created-at, confirmer, and last-used-at
- [ ] Weekly review job produces a digest of decisions, overdue action items, and recurring risks
