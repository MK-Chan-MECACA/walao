# 07 — Note-to-self delivery (Tier 0)

**What to build:** A generated summary is rendered and delivered to the user's own "Message Yourself" WhatsApp chat through the GatewayPort — the Tier 0 default: read enabled groups, message only yourself. WALAO's own delivered messages (`from_me` system echoes) are excluded from processing so briefs never loop into summaries. When the gateway was disconnected or had a coverage gap during the summarized window, the delivered summary is visibly flagged incomplete. Nothing is ever posted back to a source group.

**Blocked by:** 03 — Connection lifecycle; 06 — Summary generation.

**Status:** ready-for-agent

- [ ] Generated summary arrives as an outbound send to the user's own chat, captured by the fake gateway in tests
- [ ] `from_me` echo of the delivered summary is not ingested or summarized (loop-prevention test)
- [ ] A window with a recorded coverage gap produces a summary carrying a visible "incomplete" flag
- [ ] No outbound send ever targets a group JID or any recipient other than the user (Tier 0 boundary test)
