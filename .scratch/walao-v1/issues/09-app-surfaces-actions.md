# 09 — App surfaces: history, item actions, reminders

**What to build:** The app shows the Today Brief and in-app history of past briefs and summaries (~90-day summary retention). From any item the user can mark it complete, dismiss it, or jump back to the source chat in WhatsApp. Extracted action items require explicit user confirmation before becoming reminders — group text alone never triggers anything — and confirmed action items track owner, due date, and status.

**Blocked by:** 07 — Note-to-self delivery; 08 — Today Brief aggregation.

**Status:** ready-for-agent

- [ ] Past briefs and summaries are browsable in-app within the summary retention window
- [ ] Items can be marked complete or dismissed, and state persists across sessions
- [ ] Each item offers a jump-back link to the source WhatsApp chat
- [ ] An extracted action item becomes a reminder only after explicit confirmation; unconfirmed items never fire
- [ ] Confirmed action items carry owner, due date, and status, editable by the user
