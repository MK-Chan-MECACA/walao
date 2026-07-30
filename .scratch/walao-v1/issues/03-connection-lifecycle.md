# 03 — Connection lifecycle: pair, health, disconnect

**What to build:** The user can pair a WhatsApp account (QR or pairing code; beta users pair a dedicated test number), see connection health (connected / disconnected / re-pair required), and disconnect at any time with ingestion stopping immediately. WALAO detects gateway gaps (sequence/time discontinuities during a window) and records them so downstream summaries can be flagged incomplete rather than silently truncated.

**Blocked by:** 01 — Walking skeleton.

**Status:** ready-for-agent

- [ ] Pairing flow completes against the fake GatewayPort and produces a session tied to the user
- [ ] Connection health state is visible via the API and reflects gateway state changes
- [ ] Disconnect stops message ingestion for that session immediately; subsequent events are rejected
- [ ] A disconnection or event-sequence gap during a time window is recorded as an incomplete-coverage marker for that window
- [ ] Onboarding presents the plain-language data-use / retention / AI-provider / gateway-risk explanation before any pairing
