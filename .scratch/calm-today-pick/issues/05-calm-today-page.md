# 05 — Calm Today page

**What to build:** The Today page becomes a minute's reading instead of a scroll. It shows the headline and at most five items — or, on a quiet day, says plainly that nothing needs the user. Each shown item names its Group and offers two actions that do something in the world: open the Group in WhatsApp, and confirm as a Reminder.

Everything else stays reachable. The link to the full triage view states how many items it holds, and that view keeps every bucket, its meter, and its Done and Dismiss buttons exactly as they are.

The old Briefing rendering is **deleted**, not hidden: it drew exactly what the Console draws one scroll further down.

**Blocked by:** 03 — The pick on the Today endpoint.

**Status:** done — commit d27b204

- [x] The page shows the headline and at most five items
- [x] An empty pick renders as an explicit "nothing needs you today", not as an empty page or an error
- [x] Each shown item names the Group it came from
- [x] Each shown item carries its citations, on demand, like every other item in the product
- [x] Each shown item offers open-in-WhatsApp; items that came from an extracted action item also offer confirm-as-Reminder
- [x] Done and Dismiss are absent from the calm view and unchanged in the Console
- [x] The link to the Console states the number of remaining items
- [x] The Console still renders every bucket, its meter and its per-item buttons, unchanged
- [x] A Brief drawn from a window with a Coverage Gap still says it is partial
- [x] The duplicated bucket rendering is removed from the Briefing, not merely hidden
- [x] No inline style attributes — CSP is style-src 'self'
- [x] New styling reuses the existing design tokens; no new tokens introduced
- [x] Verified visually at desktop width with a real page load
- [x] Full suite and typecheck pass

**Notes**

The Briefing and the Console currently render the same items twice on the same page, one above the other. The fold this ticket needs already exists — this is mostly a deletion.

Done and Dismiss are dropped from the calm view on purpose. On a two-item page they are bookkeeping: nothing happens in the real world when they are clicked, acting in WhatsApp is what completes the thing, and the Brief's window rolls every twenty-four hours regardless. They stay in the Console for users who like clearing lists — and because a cleared item is never picked, the Console is also how a disagreeable pick gets corrected without waiting a day.

**The Console is the only mitigation for a wrong pick.** It must stay one obvious click away and must never be buried. A future change that makes the full list harder to reach reintroduces the risk this design accepts.

Chrome MCP does not work on this machine; use headless Chrome with a frozen timestamp for the visual check.
