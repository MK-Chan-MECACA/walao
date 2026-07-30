# 05 — Scheduler: local-time summary schedules

**What to build:** The user configures summary time, timezone, and output language (Chinese, English, or Malay) per enabled group. A scheduler driven by a controllable clock emits summary jobs at the right local time — correct across timezones and DST edges, stored as local time + timezone rather than UTC-only — and emits nothing when a group has no new messages in the window. This establishes the scheduler test seam: schedule config + clock in, job emissions out.

**Blocked by:** 02 — Group subscriptions & consent.

**Status:** ready-for-agent

- [ ] Per-group schedule with time, timezone, and language is settable via the API for enabled groups only
- [ ] Advancing the controlled clock to the scheduled local time emits exactly one job per group per window
- [ ] DST transitions and cross-timezone schedules fire at the correct local time (dedicated edge tests)
- [ ] A group with no new messages in its window produces no job (no-op, no AI cost)
