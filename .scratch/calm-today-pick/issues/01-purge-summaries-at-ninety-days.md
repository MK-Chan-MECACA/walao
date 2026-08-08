# 01 — Purge Summaries at ninety days

**What to build:** Summaries stop accumulating forever. An Account holder's Summaries older than ninety days are deleted by the expiry job that already runs, and Ask says on screen that it searches the last ninety days — so an empty answer about last year reads as expected rather than as a bug. Anything the user explicitly confirmed to keep — a Reminder, a Memory — survives the purge with its own copy of the text intact.

**Blocked by:** None — can start immediately.

**Status:** done — commit 9011528

- [x] A Summary older than ninety days is deleted when the expiry job runs
- [x] A Summary inside ninety days is untouched by the same run
- [x] A confirmed Reminder whose source Summary was purged still exists, keeps its text, and holds a null Summary reference
- [x] A confirmed Memory whose source Summary was purged still exists and keeps its content
- [x] Per-item state and quality samples belonging to a purged Summary are gone with it
- [x] The Ask page states the ninety-day horizon in its own voice, in one place, not two
- [x] The retention window is a named constant, not a literal buried in a query
- [x] Full suite and typecheck pass

**Notes**

The schema already documents this intent — the app-surfaces migration describes a Reminder as outliving its "~90-day source summary", and the sender-names module assumes Summaries are read for ninety days. This ticket implements a promise the codebase already makes. Summaries are currently the only unbounded table in the system.

The cascade behaviour that makes this safe is already in place and needs no schema change: item state and quality rows cascade, Reminders and Memories are nullable references that copy their text at confirmation time.
