# 04 — Validate the pick against a real day

**What to build:** Confidence that the judgement is actually good, before anything starts pushing it to people's phones.

Run the real Picker over a real day of real Groups — not seeded fixtures — and read the result by eye. Compare what it picked against what a human who read all the messages would have picked. Iterate the prompt until they agree. Record what was run, what it picked, what a human picked, and what changed in the prompt as a result.

This is a gate, not a feature. It produces a judgement and possibly a prompt change; it may produce no code at all.

**Blocked by:** 03 — The pick on the Today endpoint.

**Status:** done — verdict yes, recorded in docs/picker-validation.md

- [x] The real Picker is run against at least one real day with a realistic item count (tens of items, several Groups), not a seeded fixture
- [x] A message that merely thanks or congratulates the Account holder, including one that @mentions them, is **not** picked
- [x] A message that asks the Account holder a direct question **is** picked
- [x] An item addressed to somebody else is not picked, even when it names the Account holder
- [x] A dated commitment the Account holder would be harmed by missing is either picked or consciously accepted as out of scope
- [x] A genuinely quiet day produces an empty pick rather than padding
- [x] The headline reads as a sentence a person would write, not a template
- [x] Disagreements between the model's pick and the human's pick are written down, with what changed in the prompt as a result
- [x] If the prompt changed, the picker prompt tests still pass and are updated where a rule was added
- [x] A short written verdict is recorded: is the distinction reliable enough to push to a phone, yes or no

**Notes**

**This is the load-bearing assumption of the entire feature.** Everything downstream — the daily message, the cadence work, the pings — rests on a model separating *"MK please fix this"* from *"thanks MK"*. That distinction **is** the product. No amount of scheduler correctness compensates for it being wrong, and the prompt is the thing to iterate on.

It blocks tickets 06 and 08 deliberately. A wrong pick on the web page is opt-in and visible — the user chose to look and the full list is one click away. A wrong pick pushed to WhatsApp is neither, and it is the kind of mistake that gets an app muted.

It does **not** block ticket 05. The web page can ship on a not-yet-perfect pick.

If the verdict is no, that is a legitimate outcome and stops the line. Say so plainly rather than proceeding and hoping.
