# 02 — Capture the Account holder's own WhatsApp identity

**What to build:** WALAO learns who the Account holder is on WhatsApp, so that later work can answer "was I @mentioned in this message?" and "is this item addressed to me?". When a Session becomes connected, the gateway is asked for the paired identity and the Session stores both of the person's addressing forms plus the display name they post under. A gateway that cannot name the Session leaves those empty, and everything else in the product carries on unaffected.

Nothing is user-visible in this ticket. It exists so that ticket 03 and ticket 08 have a fact to work from rather than a guess.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] Connecting a Session stores the paired identity in both addressing forms and the display name
- [x] A gateway that cannot name the Session leaves all three empty and the connect still succeeds
- [x] Failure to reach the gateway does not fail the connect
- [x] Identity resolves per Account, newest identified Session first, matching ADR-0001's one-Session-per-Account model
- [x] The gateway fake exposes the same capability so tests never depend on a real provider
- [x] The adapter comment asserting that nothing above the port ever holds the paired number is rewritten to say what is now true and why
- [x] The privacy documentation gains a line naming what is stored and what it is used for, in both language sections of the product spec
- [x] Full suite and typecheck pass

**Notes**

**This deliberately overturns an existing rule.** The gateway adapter currently hashes the paired number the moment it arrives, with a comment stating that nothing above the port ever holds the number itself. That was correct while the only consumer — the once-per-number Trial check — needed equality and nothing more, which a hash satisfies. Mention matching is a substring test against message bodies, and equality on a hash cannot perform it.

The comment and the docs are corrected **in this ticket, not later**. A rule that is no longer true but still written down is worse than no rule: the next reader trusts it.

This is not a new class of data. The raw identity of every *other* member of every enabled Group is already stored, on messages and in the contact list. What was previously withheld was only the Account holder's own, and only because nothing needed it.

WhatsApp addresses one human two ways — a phone-based id and a LID — and a mention in a message body is written as the bare digits of one of them. Both forms are needed or matching silently fails for half of all senders.

The display name is stored for a different reason than matching: an extracted item reads "Lee Yee asked MK Chan whether the format is OK", and without knowing the Account holder is MK Chan, no downstream judgement can tell that line is addressed to them.
