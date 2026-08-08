# 06 — One daily WhatsApp message

**What to build:** WALAO stops being a source of message volume. The per-Group section dumps — one long direct message per Group Summary, all six sections, every item — stop entirely. In their place, one message a day carries the pick: the headline, the picked items each named with its Group, and a link to the app for everything else. A quiet day says so explicitly rather than sending nothing.

The Account holder chooses when it arrives, and in which timezone, from Settings. An Account that never opens Settings still gets exactly one message a day at a sensible default. An Account that never opens the web app at all still gets its message — the whole product works inside WhatsApp.

**Blocked by:** 03 — The pick on the Today endpoint. 04 — Validate the pick against a real day.

**Status:** done

- [x] No direct message is sent per Group Summary any more
- [x] Summaries are still marked delivered as they are processed, so the drain keeps its shape
- [x] The per-Group renderer survives — it is still how a Summary payload renders on screen
- [x] One message a day carries the headline, the numbered picked items with their Group names, and a link to the app
- [x] An empty pick sends a message saying nothing needs the user, not silence and not an empty list
- [x] The message is sent exactly once; a restart between send and commit cannot produce a second one
- [x] The Account holder can set a digest time and timezone in Settings, and an invalid timezone is refused
- [x] An Account that never touches Settings receives exactly one message a day at the default
- [x] An Account that never opens the web app still receives its message
- [x] Delivery respects the existing Processing Block — no message while halted, paused, unpaid, over cap or disconnected
- [x] Delivery only ever targets a connected Session
- [x] A picked item whose Summary was purged between pick and send is silently omitted, never rendered as an error
- [x] Existing delivery tests are rewritten to assert the new behaviour, not deleted
- [x] Full suite and typecheck pass

**Notes**

Delivery is claimed a row at a time with row locking and skip-locked, matching the existing drains. The delivery timestamp is the idempotency key. At-least-once, never at-most-once — a crash between send and commit can duplicate a chat message but never lose one, which is the same trade the current delivery path already makes.

Two paths write the day's record: the web page when a user opens it, and a digest tick for Accounts who never do. The tick is a no-op for Accounts that already have one.

Existing subscribers are **not** migrated. They simply start receiving one message instead of three, at the default time. Whether to announce that is a product decision, not part of this ticket.

The message is English regardless of Summary language, inheriting the existing behaviour of the per-Group renderer. Localising it is out of scope.
