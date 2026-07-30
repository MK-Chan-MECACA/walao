# 08 — Today Brief aggregation

**What to build:** The user's per-group summaries are combined into one Today Brief that ranks items across all groups into "needs action", "decided", and "worth noting". Duplicate items across groups are merged while every source stays visible. The brief is built from summaries, never from raw text, and is served via the today-brief API endpoint.

**Blocked by:** 06 — Summary generation.

**Status:** ready-for-agent

- [ ] Today Brief endpoint returns items from all the user's groups, ranked into the three buckets
- [ ] The same decision appearing in multiple groups is merged into one item retaining all source references
- [ ] Brief construction reads only stored summaries, not raw messages (works even after raw expiry)
- [ ] A day with no summaries returns an explicit empty brief, not an error or fabricated content
