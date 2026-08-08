# 08 — Tag pings

**What to build:** When somebody @mentions the Account holder with something that genuinely needs them, they hear about it within minutes instead of at the digest time. When somebody @mentions them to say thank you, they hear nothing at all.

Every mention is judged before anything is sent, through the same AI port that builds the daily pick — so one prompt owns the distinction between a request and a courtesy, and the ping and the digest can never disagree about it. A ping names the Group it came from.

A ceiling caps pings per Account per hour so one chaotic Group cannot flood anyone. Anything past the ceiling is a delay, not a loss: it still reaches the daily message.

**Blocked by:** 02 — Capture the Account holder's own WhatsApp identity. 03 — The pick on the Today endpoint. 04 — Validate the pick against a real day.

**Status:** done

- [x] A stored message that @mentions the Account holder is queued for judgement
- [x] A message mentioning somebody else is not queued
- [x] A mention of a longer id that merely begins with the Account holder's digits is not queued
- [x] A mention is recognised whichever of the Account holder's two addressing forms the sender's client used
- [x] A mention judged as needing the user produces one WhatsApp ping naming its Group
- [x] A mention judged as needing nothing produces no message and is never judged again
- [x] A replayed webhook event cannot queue the same message twice
- [x] The per-Account hourly ceiling holds, and is counted **before** the model call so a suppressed ping costs nothing
- [x] A suppressed mention still appears in the daily message
- [x] No ping while the Account is halted, paused, unpaid, over cap or disconnected
- [x] An Account whose identity is unknown gets no pings, and its daily message is unaffected
- [x] Queued ping records disappear with their message at raw expiry, needing no second sweep
- [x] Message bodies are read through per-Account envelope encryption (ADR-0002)
- [x] Full suite and typecheck pass

**Notes**

Detection happens where the message is stored, because that is the only point where the plaintext is already in hand. Anywhere later means decrypting a second time to answer a question that is answerable for free.

The judgement reuses the pick port with a single candidate: an empty result means this mention needs nothing. That reuse is the design, not a shortcut — a second prompt for the same question would drift from the first.

**This is the only unprompted interruption in the product,** and the feature most likely to be experienced as spam if the judgement is loose. The hourly ceiling is a backstop, not a substitute for the judgement being right — which is why ticket 04 gates this one.

Already-paired Sessions have no stored identity until their next connect. Those Accounts get no pings until then, and nothing else about them changes. No backfill.
