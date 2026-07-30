# 15 — Credits & plan limits

**What to build:** Usage is billed as credits (~1 credit ≈ 1 daily group summary), never raw tokens. The user sees per-group credit burn so expensive groups can be muted. Plans carry visible limits on groups, message volume, and AI usage; hitting a limit degrades gracefully with a clear message, keeping cost bounded per plan.

**Blocked by:** 06 — Summary generation.

**Status:** ready-for-agent

- [ ] Each generated group summary decrements the user's credit balance by its credit cost
- [ ] Per-group credit burn is visible to the user over a time period
- [ ] Plan limits on group count, message volume, and AI usage are enforced with clear user-facing messaging when reached
- [ ] Credit accounting reconciles with the per-summary metrics recorded in ticket 06 (no unmetered AI spend)
