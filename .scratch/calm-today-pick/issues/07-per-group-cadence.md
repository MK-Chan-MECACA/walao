# 07 — Per-Group cadence

**What to build:** The Account holder decides which Groups are allowed to interrupt them. A Group left alone summarizes once a day and never interrupts — its items wait for the daily message. A Group marked as one they cannot afford to miss closes its window on an interval and pushes the pick as soon as that window holds something for them. A window with nothing for them sends nothing.

The control states what it will do to the user, not just how often it runs: "daily — never interrupts me" against "every four hours — may message me".

On the Free plan an interval cadence is refused outright with a clear payment-required answer, because a single four-hour Group would consume more than the whole plan's daily Summary allowance and starve every other Group on the Account.

**Blocked by:** 06 — One daily WhatsApp message.

**Status:** done

- [x] A Group can be set to daily or to an interval, from the Groups page
- [x] The control's wording states the consequence, not only the frequency
- [x] A Group on an interval fires again inside the same local calendar day once its interval has elapsed
- [x] A Group on an interval does **not** fire before its interval has elapsed
- [x] A Group on daily still fires exactly once per local calendar date, and remains correct across DST
- [x] An interval window holding nothing for the Account holder sends no message
- [x] An interval window holding something for them pushes it without waiting for the digest time
- [x] Interval cadence is refused on the Free plan with a payment-required response
- [x] A refused cadence writes no schedule at all — the Group is left exactly as it was
- [x] The Groups page states a Group's cadence in its summary line
- [x] Full suite and typecheck pass

**Notes**

The daily rule stays as it is — a local calendar date comparison, which is DST-proof for free: a spring-forward time that does not exist fires at the next tick after the jump, and a fall-back repeated hour cannot double-fire because the local date already matches. Interval Groups ignore local time entirely and compare elapsed duration instead, firing several times a day by design.

**Refusing rather than silently capping is the point.** Free allows five Summaries a day; one Group on a four-hour cadence opens six windows. Capping it would leave a setting that says one thing and does another. Refusing keeps the setting honest.

A Group set to an interval is a statement about importance, not about frequency. That is why the wording matters as much as the mechanism — the user is choosing an interruption budget, not a polling rate.
