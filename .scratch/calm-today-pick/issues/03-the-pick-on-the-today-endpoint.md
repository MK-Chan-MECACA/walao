# 03 — The pick on the Today endpoint

**What to build:** The Today endpoint stops being only a list and starts carrying a judgement: at most five items that genuinely need this Account holder today, plus one headline sentence describing what the day amounts to. Zero picked items is a correct and expected answer.

The judgement is made by a new AI port, fed one deterministic fact it is never asked to infer — whether the Account holder was @mentioned in the item's source messages. The result is cached per Account per day against a fingerprint of exactly what the model was shown, so re-reading the page is free, a new Summary buys one call, and a quiet day costs nothing at all.

Verifiable on its own by calling the endpoint: the response carries the pick, and the picker fake records precisely what it was fed.

**Blocked by:** 02 — Capture the Account holder's own WhatsApp identity.

**Status:** done

- [x] The endpoint response carries a headline and the picked item keys alongside the existing buckets
- [x] The picked keys are always a subset of the items actually offered — an invented key never reaches the response
- [x] Duplicate keys collapse, and the pick is capped at five **in code**, not by asking the model nicely
- [x] An empty pick is a valid response, not an error
- [x] Malformed model output yields an empty pick rather than an error surfaced to the user
- [x] Loading the page three times with unchanged content makes exactly one model call
- [x] A new Summary landing changes the fingerprint and buys exactly one more call
- [x] A day with no Summaries makes no model call at all
- [x] An item the user already marked Done or Dismissed is never offered to the model
- [x] An item whose source message @mentions the Account holder is offered with its tagged flag set
- [x] A mention of a longer id that merely begins with the Account holder's digits does **not** set the flag
- [x] An Account with no known identity gets tagged=false everywhere, never tagged=true
- [x] Tag detection reads message bodies through per-Account envelope encryption (ADR-0002), never a raw column
- [x] Past raw-message expiry, tagging falls back to the resolved @Name already present in the item text
- [x] A deployment with no Anthropic key still serves a pick, via a deterministic local rule
- [x] The picker prompt states the rules that carry product meaning: at most five, empty is correct, being thanked needs nothing, only return keys you were given
- [x] Items reach the model as untrusted data inside a delimiter, with no tool access
- [x] Another Account's Summaries never appear in the pick
- [x] The test harness gains a picker fake with canned output and recorded calls, mirroring the existing summarizer and answerer fakes
- [x] Full suite and typecheck pass

**Notes**

**A separate port, not a method on the existing Summarizer.** The two output contracts are incompatible: the Summarizer's is the six-section cited payload forced through its own validator; this one is a headline and a list of keys. One port holding both would need a validator that can validate neither.

**The safety property is not the prompt.** The model can only return keys, and validation drops every key it was not given — so a hallucinated item has no channel to arrive through. The cap is enforced in code for the same reason: the calm view must not be able to grow back into a list.

Shape, from a prototype, kept because prose states it less precisely:

```
Pick = { headline: string, keys: string[] }        // keys.length <= 5, always
PickCandidate = {
  key,            // stable identity: the item's Summary, section and index
  text,
  group_name,
  bucket,         // needs_action | decided | worth_noting
  tagged          // deterministic, computed before the call
}
```

The candidate key is the same string the web app already uses to address item state, so "picked" and "cleared" are one identifier and either can filter the other.

A mid-tier model is the right default rather than the Summarizer's top-tier one: this is a relevance judgement over one-line items, not extraction, and the same call sits on the ping path in ticket 08 where latency is felt.

A re-pick replaces the cached record but must clear its delivery timestamp **only when the picked keys actually changed** — otherwise a page refresh after ticket 06's message has gone out would cause a second one.

Candidates from the decided and worth-noting buckets are offered, but nothing in the prompt encourages returning them. That is intentional and revisitable.
