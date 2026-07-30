# 14 — Product-wide gateway halt switch

**What to build:** An operator-triggered halt switch that stops all gateway activity product-wide — ingestion and outbound — for the scenario of a WhatsApp/Meta legal notice. The shutdown path is decided and rehearsed before it's needed: flipping the switch takes effect immediately, users see an honest status, and briefs during the halt are flagged incomplete rather than silently missing data.

**Blocked by:** 07 — Note-to-self delivery.

**Status:** ready-for-agent

- [ ] Operator can trigger the halt; all gateway sends stop immediately and new webhook events are refused
- [ ] Halt state is visible to users via connection health / status surfaces
- [ ] Windows overlapping a halt produce incomplete-flagged summaries, consistent with the gap-detection behavior
- [ ] Un-halting resumes normal operation without data corruption or duplicate processing
