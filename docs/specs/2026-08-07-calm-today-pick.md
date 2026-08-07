# Calm Today — the Brief becomes a pick, not a list

> Spec, 2026-08-07. Companion implementation plan: `docs/superpowers/plans/2026-08-07-calm-today-pick.md`.
> Domain vocabulary per `docs/product-spec.md`. ADRs respected: 0001 (one Session per Account), 0002 (per-Account envelope encryption), 0003 (Singapore residency, AI calls disclosed as offshore).

## Problem Statement

WALAO's promise is *每天一分钟，看懂所有重要群组* — one minute a day, understand every important Group. What a user actually meets is a Brief listing every item extracted from every Summary in the last 24 hours: 3 Groups produced 47 items, 17 of them in Needs Action, each row carrying three buttons. Clearing the page is 51 decisions.

The same content arrives a second time on WhatsApp, because delivery sends one long direct message per Group Summary containing all six sections. Three Groups means three long messages carrying the same 47 bullets.

Nothing in either surface distinguishes an item that needs this person from one that merely mentions them, or from one addressed to somebody else entirely. A Group member writing *"thanks MK!"* and a Group member writing *"MK, the banner is still wrong"* produce items of identical weight. The user must read everything to find the few things that matter, which is the exact labour the product exists to remove. The Brief does not save time; it relocates the reading.

Two further consequences follow from the same root:

- Urgent things wait. A Group summarizes once per local calendar day, so something needing an answer at 10am surfaces at 22:00.
- Summaries are never deleted. They are the only unbounded table in the schema, growing indefinitely per Account, while the code already documents an intended ~90-day life for them.

## Solution

**Silence becomes the default output.** WALAO decides what needs the user; the web page becomes the archive.

A new AI step runs over the day's already-extracted items and returns at most five that genuinely need this Account holder today, plus one headline sentence. Zero is a legitimate and expected answer — a quiet day produces *"Nothing needs you today."* and nothing more. The judgement is fed one deterministic fact it is never asked to infer: whether the Account holder was @mentioned in the source messages.

That pick, not the item list, is what gets delivered. WhatsApp receives **one** direct message a day carrying the pick and a link to the app. Per-Group section dumps stop.

Two clocks replace one:

- A Group on a daily cadence never interrupts. Its items wait for the Account's chosen digest time.
- A Group set to an interval is one the user cannot afford to miss. When its window closes with something in it, the pick goes out immediately. Empty window, silence.
- Independently of either, an @mention of the Account holder is judged the moment it is stored and, if it genuinely needs them, pinged immediately. Being thanked is a mention that needs nothing, and stays silent.

The web Brief shows the same pick. The full triage list — every bucket, the meter, Done and Dismiss — survives untouched one click away in the Console view, which already renders exactly that.

Summaries gain the 90-day expiry the codebase already assumes they have, and Ask states its horizon plainly.

## User Stories

1. As an Account holder, I want the Today page to show me at most five things, so that reading it takes a minute instead of ten.
2. As an Account holder, I want the page to say "nothing needs you today" when nothing does, so that a short page reads as good news rather than a broken app.
3. As an Account holder, I want the app to distinguish someone asking me for something from someone thanking me, so that politeness in a Group does not become work on my list.
4. As an Account holder, I want an item where I was @mentioned to be weighted more heavily, so that a message aimed at me does not sit below one aimed at nobody.
5. As an Account holder, I want being @mentioned to raise importance without settling it, so that a Group that tags everybody by habit does not fill my page.
6. As an Account holder, I want the five picked items to name the Group each came from, so that I know where to go without opening anything.
7. As an Account holder, I want one line telling me what the day amounts to, so that I understand the shape of it before reading any item.
8. As an Account holder, I want a picked item to take me straight to its Group in WhatsApp, so that acting on it is one tap on my phone.
9. As an Account holder, I want to turn a picked item into a Reminder, so that "not now" does not mean "forgotten".
10. As an Account holder, I want the picked items to carry their citations like every other item, so that I can check what a claim was drawn from before acting on it.
11. As an Account holder, I want everything not picked to remain reachable, so that I can verify the app did not hide something from me.
12. As an Account holder, I want the link to the rest to state how many items it holds, so that I know whether it is worth opening.
13. As an Account holder who likes clearing things, I want the full triage list with its meter and its Done and Dismiss buttons to still exist, so that the change does not take away a workflow I use.
14. As an Account holder, I want an item I already marked Done or Dismissed to never be picked, so that clearing something makes it stay cleared.
15. As an Account holder, I want a picked item I disagree with to be dismissable from the full list, so that a bad pick can be corrected without waiting a day.
16. As an Account holder, I want refreshing the Today page to be free, so that reading it twice does not consume my Credits.
17. As an Account holder, I want the pick to update when a new Summary lands, so that the page is not stale after an evening Group summarizes.
18. As an Account holder, I want the pick to stay stable when nothing has changed, so that the page does not reshuffle under me between reads.
19. As an Account holder, I want one WhatsApp message a day instead of one per Group, so that WALAO is not itself a source of message volume.
20. As an Account holder, I want that message to contain the pick and a link, so that reading it on my phone needs no scrolling.
21. As an Account holder, I want the daily message to say "nothing needs you today" on a quiet day, so that I know the system ran and found nothing rather than failed.
22. As an Account holder, I want to choose what time the daily message arrives, so that it lands when I actually read messages.
23. As an Account holder, I want to choose the timezone for that time, so that it means what I think it means when I travel.
24. As an Account holder who never opens Settings, I want a sensible default digest time, so that I still get exactly one message a day.
25. As an Account holder who never opens the web app, I want the daily message to arrive anyway, so that the app works entirely inside WhatsApp.
26. As an Account holder, I want the daily message to arrive exactly once, so that a server restart does not double-message me.
27. As an Account holder, I want to mark a specific Group as one that may interrupt me, so that the client Group I cannot miss is treated differently from the noisy one.
28. As an Account holder, I want a Group I have not marked to never interrupt me, so that the calm default is the default.
29. As an Account holder, I want an interrupting Group to stay silent when its window holds nothing for me, so that a cadence setting does not become a scheduled interruption.
30. As an Account holder, I want the cadence control to state what it will do to me, not just how often it runs, so that I can choose without reading documentation.
31. As an Account holder on the Free plan, I want to be told plainly that interval cadence needs Pro, so that I do not silently exhaust my daily Credits on one Group.
32. As an Account holder, I want to be pinged as soon as someone @mentions me with something that needs me, so that I can answer within minutes instead of at 22:00.
33. As an Account holder, I want a thank-you that @mentions me to produce no ping, so that the ping keeps meaning something.
34. As an Account holder, I want a mention of someone whose number resembles mine to produce no ping, so that I am not pinged for other people's messages.
35. As an Account holder, I want pings to stop after a handful in an hour, so that one chaotic Group cannot flood me.
36. As an Account holder, I want anything past that ceiling to still appear in the daily message, so that a suppressed ping is a delay, not a loss.
37. As an Account holder who has never posted in a tracked Group, I want tagging to work anyway, so that my identity does not depend on my having spoken.
38. As an Account holder whose Session cannot be identified by the gateway, I want the daily digest to work unaffected, so that one missing capability does not disable the product.
39. As an Account holder, I want a mention to be recognised whichever of my two WhatsApp identities the sender's client used, so that pings do not silently never arrive.
40. As an Account holder, I want the app to know the name I post under, so that an item reading "Lee Yee asked MK Chan…" is understood to be addressed to me.
41. As an Account holder, I want no ping while my Account is paused, halted, over cap or disconnected, so that the existing Processing Block means what it says everywhere.
42. As an Account holder, I want a Brief drawn from a window with a Coverage Gap to still say it is partial, so that the new surface keeps the old honesty.
43. As an Account holder, I want Summaries older than ninety days to be deleted, so that my chat history does not accumulate on WALAO's servers forever.
44. As an Account holder, I want Ask to state the ninety-day horizon, so that an empty answer about last year is understood rather than mistaken for a bug.
45. As an Account holder, I want a Reminder I confirmed to survive its source Summary being purged, so that deleting old data never deletes something I chose to keep.
46. As an Account holder, I want a Memory I confirmed to survive the same purge, for the same reason.
47. As an Account holder, I want the picked item to still render in the daily message if its Summary was purged between pick and send, or to be silently omitted rather than shown as an error.
48. As an operator, I want the pick to cost at most one model call per Account per day of changed content, so that the feature's cost is predictable.
49. As an operator, I want a day with no Summaries to cost no model call at all, so that inactive Accounts are free.
50. As an operator, I want tag-ping judgement to cost one call per mention and be capped per Account per hour, so that a hostile or chaotic Group cannot run up a bill.
51. As an operator, I want the pick to fail closed to an empty pick rather than an invented one, so that a model outage degrades to silence rather than to noise.
52. As a developer, I want the pick to be unable to return an item that was not offered to it, so that a hallucination has no channel to reach a user through.
53. As a developer, I want the maximum pick size enforced in code rather than requested in a prompt, so that the calm view cannot grow back into a list.
54. As a developer, I want the deployment to run with no Anthropic key, so that the pipeline stays locally runnable with no AI spend.
55. As a developer, I want one prompt to own the "is this actually for me" rule, so that the ping and the digest cannot disagree about it.
56. As a security reviewer, I want extracted items to reach the model as untrusted data inside a delimiter with no tool access, so that the new AI step inherits the boundary the other two already hold.
57. As a security reviewer, I want tag detection to read message bodies through per-Account envelope encryption, so that ADR-0002 is not bypassed by a new feature.
58. As a security reviewer, I want the storage of the Account holder's own WhatsApp identity documented in the privacy policy, so that what is held matches what is disclosed.

## Implementation Decisions

### A third AI port

A new **Picker** port joins Summarizer and Answerer as the third AI boundary, with the same shape: plain data in, plain data out, no tool access, output forced through a validator before anything downstream sees it.

It is a separate port rather than a method on Summarizer because the two output contracts are incompatible — the Summarizer's is the six-section cited payload validated by `validateSummary`; the Picker's is a headline and a list of item keys. One port holding both would need a validator that can validate neither.

The port is **reused, not duplicated, for tag-ping judgement**: a single tagged message is passed as a one-item candidate list, and an empty result means "this mention needs nothing". One prompt therefore owns the distinction between a request and a courtesy, and the two surfaces cannot drift.

Default model is a mid-tier one rather than the Summarizer's top-tier: the task is a relevance judgement over one-line items, not extraction, and the same call sits on the ping path where latency is felt. A key-less deployment falls back to a deterministic local rule (tagged action items first, capped) exactly as Summarizer and Answerer already do.

### The pick contract

The model returns only a headline and item keys. Validation drops every key that was not among the candidates, collapses duplicates, truncates the headline, and caps the list at five. An empty pick is valid and expected — it is the outcome the feature exists to make possible. Garbage input yields an empty pick, never an error surfaced to the user.

Prototyped shape, kept because prose states it less precisely:

```
Pick = { headline: string, keys: string[] }        // keys.length <= 5, always
PickCandidate = {
  key,                 // stable identity: the item's Summary, section and index
  text,
  group_name,
  bucket,              // needs_action | decided | worth_noting
  tagged               // deterministic, computed before the call
}
```

The candidate key is the same string the web app already uses to address item state, so "picked" and "cleared" are the same identifier and one can filter the other.

### The `tagged` signal

Deterministic and computed before the call. The model is told it, never asked to infer it.

WhatsApp writes a mention into the message body as the bare digits of one of a person's two identities — the phone JID or the LID. Matching therefore needs **both** forms, and a match must not fire on a longer id that merely begins with the same digits. The existing helper that collapses a device-suffixed reference, a contact entry and a bare mention to one human is reused rather than reimplemented.

Tagging reads the item's own source messages while they remain inside the raw retention window, decrypting through the per-Account key (ADR-0002). Past raw expiry it falls back to the item text, where mentions have already been rewritten to `@Name` by the existing resolver. Unknown identity yields `false`, never `true` — a guessed ping is worse than a missed one, and the daily digest carries the item either way.

### Self identity

Captured from the gateway when a Session transitions to connected, stored on the Session in both addressing forms plus the display name.

This deliberately supersedes an existing rule stating that nothing above the gateway port ever holds the paired number itself. That rule existed because the only consumer — the once-per-number Trial check — needs equality and nothing more, which a hash satisfies. Mention matching is a substring test against message bodies, which equality on a hash cannot perform. The comment asserting the old rule is rewritten in the same change, and the privacy documentation gains a line, so what is held matches what is disclosed. This is not a new class of data: the raw identity of every *other* member of every enabled Group is already stored.

The display name is captured for a different reason than matching: an extracted item reads *"Lee Yee asked MK Chan whether the format is OK"*, and without knowing the Account holder is MK Chan the model cannot tell the line is addressed to them.

Identity is resolved per Account, newest identified Session first (ADR-0001: one Session per Account). A Session the gateway cannot name leaves the columns empty, which disables pings for that Account and affects nothing else. Already-paired Sessions fill in on their next connect; no backfill.

### Caching the pick

A new per-Account, per-day **Brief record** stores the headline, the picked keys, a fingerprint of exactly what the Picker was shown, a due time, and a delivery timestamp.

The today endpoint recomputes on every page load, so an uncached call would bill a refresh. The fingerprint covers every candidate's key, text and tagged flag: identical inputs serve the stored row for free; a new Summary or a newly cleared item changes it and buys one call. A day with no Summaries never reaches the model at all.

A re-pick replaces the row. It clears the delivery timestamp **only if the picked keys actually changed**, so a refresh after the daily message has gone out cannot cause a second one.

### Delivery

The daily message replaces per-Group delivery entirely. Summaries are still marked delivered as they are processed — the drain keeps its shape and a Summary becoming "handled" now means "eligible to be picked from". The per-Group renderer is retained; it is still how the app renders a Summary payload on screen.

The message carries the headline, the numbered picked items each with its Group name, and a link to the app for everything else. An empty pick renders as an explicit statement that nothing needs the user.

Delivery is claimed row-at-a-time with row locking and skip-locked, matching the existing drains, and the delivery timestamp is the idempotency key. At-least-once, never at-most-once: a crash between send and commit can duplicate a chat message, never lose one — the same trade the existing delivery path already makes. Delivery respects the existing Processing Block and only ever targets a connected Session.

An item whose Summary was purged between pick and send is silently omitted rather than rendered as an error.

### Two clocks

**Cadence becomes a property of the Group** and is stated as a promise rather than a frequency. Absent means daily: the Group summarizes on its local time and never interrupts. Set to an interval means the Group's window closes on that interval and may push.

The scheduler's once-per-local-calendar-date guard is replaced with a branch. Daily Groups keep the calendar-date rule, which is DST-proof because it compares local dates rather than elapsed durations. Interval Groups ignore local time entirely and fire on elapsed duration since their last window closed, several times a day by design.

Interval cadence is refused on the Free plan at the API with a payment-required response, not silently capped. Free allows five Summaries a day; a single four-hour Group would consume six and starve every other Group on the Account. Refusing is the only option under which the setting does not lie about what it will do.

**The digest clock is a property of the Account**: a local time and a timezone, defaulting so that an Account which never opens Settings still receives exactly one message a day. A tick builds the pick for any Account whose digest time has passed and which has no Brief record for the day yet — that is the path for users who never open the web app. Accounts who did open it already have the record, and the tick is a no-op for them.

### Tag pings

Mention detection happens at message-store time, because that is the only point where the plaintext is already in hand; anywhere later would mean decrypting a second time to answer a question already answerable for free. A detected mention enqueues a **ping record** keyed on the message, so a replayed event cannot queue twice, and cascaded from the message so raw expiry cleans it up with no second sweep.

A drain judges each queued mention through the Picker and either sends or marks it judged-silent. Either outcome is terminal; only unjudged records are work.

The per-Account hourly ceiling is counted **before** the model call, using the existing rate limiter. Over the ceiling the record is marked judged-silent and costs nothing — the item still reaches the user in the daily digest. Pings respect the Processing Block like every other delivery stage.

### Retention

Summaries are purged at ninety days by the existing expiry job. This implements an intent the schema already documents. Item states and quality samples cascade away with their Summary, which is correct — there is nothing left to hold a state about. Confirmed Reminders and Memories reference the Summary nullably and hold their own copy of the text, so a purge never removes something a user chose to keep. Ask states the horizon on screen.

### The web Brief

The calm view renders the pick; the three bucket sections stay in the DOM because the Console view renders into them. The Briefing's own bucket rendering is **deleted** — it drew exactly what the Console draws one scroll further down.

A picked row carries two actions, both of which do something in the world: open the Group in WhatsApp, and confirm as a Reminder. Done and Dismiss are not offered there. On a two-item page they are bookkeeping — acting in WhatsApp is what completes the thing, and the Brief's window rolls every 24 hours regardless. Both remain in the Console for users who clear lists, and a cleared item is never picked, which is also how a disagreeable pick is corrected without waiting for a re-run.

The link to the Console states how many items it holds.

## Testing Decisions

A good test here asserts what a user or an operator can observe: an HTTP response body, a row in the database, a message captured at the gateway fake, a model call captured at the picker fake. It never asserts how a function reached that result, and never reaches into module internals. Every test in this codebase already follows that pattern and the new ones extend it rather than introducing a second style.

**Prior art to follow, in order of preference:**

- The existing Brief tests are the closest model for the pick: seed an Account, a Session, a Group and Summaries through the harness, call the real endpoint over real HTTP against real Postgres, assert on the response body. Tenant isolation is asserted the same way it already is — a second Account's Summary must not appear.
- The existing Summarizer-fake tests are the model for asserting *what the model was fed*: the fake records every input, so a test can assert the candidate list contained the right items with the right tagged flags without asserting anything about the prompt.
- The existing gateway-fake tests are the model for delivery: every outbound message lands in an array on the fake and is asserted as text.
- The existing scheduler tests are the model for cadence: an injected clock in, emitted jobs out, no network and no fakes.
- The existing prompt tests are the model for the picker prompt: assert the rules that carry product meaning are present, not the wording around them.

**What is tested where:**

- *Pure functions, no database:* mention matching (both identity forms, device suffixes, the longer-id near-miss, unknown identity), pick validation (invented keys dropped, duplicates collapsed, cap enforced, empty valid, garbage yields empty), and daily-message rendering (numbering, Group names, the empty case, no nulls rendered).
- *Through the harness:* the pick appearing on the endpoint; exactly one model call per day of unchanged content; a re-pick when a Summary lands; cleared items never offered; the tagged flag set from a real @mention in a real stored message; an invented key dropped end to end; a day with no Summaries costing no call.
- *Through the harness:* a mention queueing a ping record; a mention of somebody else not queueing one; a judged-needed mention producing a gateway send naming its Group; a judged-silent mention producing no send and a terminal record; the hourly ceiling holding.
- *Through the harness:* interval cadence refused on Free with no schedule written.
- *Scheduler, injected clock:* an interval Group re-firing inside one calendar day, not firing before its interval elapses, and a daily Group still firing once per local calendar date.
- *Retention:* a Summary past ninety days deleted, one inside it kept, and a confirmed Reminder surviving with a null Summary reference.
- *Delivery:* the existing per-Group delivery assertions are rewritten rather than deleted — they now assert that no chat message is sent and that Summaries are still marked delivered.

The harness gains a picker fake with canned output and recorded calls, mirroring the summarizer and answerer fakes exactly. No new test infrastructure beyond that.

## Out of Scope

- **Migrating existing subscribers off per-Group delivery.** They simply start receiving one message at the default digest time. A transitional announcement is a product decision, not part of this work.
- **Backfilling self identity for already-paired Sessions.** They fill in on the next connect. Until then tag pings are off for that Account and the digest is unaffected.
- **Surfacing dates and decisions in the pick.** Candidates from those buckets are offered to the model, but nothing in the prompt encourages returning them. If dates start being missed, that is a prompt line, not a redesign.
- **Message-level deep links.** WhatsApp publishes no way to open a specific message, and no way to open a specific Group on WhatsApp Web. Chat-level deep linking remains best-effort, which is why the daily message is the primary surface and the citations remain the reliable path.
- **Localising the daily message.** Section labels are already English regardless of Summary language; the pick inherits that and the existing note about localising when a non-English beta user asks still stands.
- **Per-Account tuning of the pick size.** Five is a fixed ceiling.
- **Changing what the Summarizer extracts.** This work re-ranks and re-presents existing extraction; the six-section contract is untouched.

## Further Notes

**The load-bearing assumption is untested.** Everything downstream of the Picker rests on a model being able to tell *"MK please fix this"* from *"thanks MK"*. That distinction is the product. It should be checked by hand against a real day of real Groups before the delivery and cadence work ships — the prompt is the thing to iterate on, and no amount of scheduler correctness compensates for it being wrong.

**Storage effect is net negative.** The new records are negligible — roughly a kilobyte and a half per Account per day for Brief records, two columns on a Session, and ping records that cascade away with their messages. Interval cadence multiplies Summary volume for the Groups it is enabled on, but the ninety-day purge removes an unbounded growth curve that exists today. An Account running interval cadence after this change stores less than a daily-only Account stores today after its first year.

**A wrong pick is the main product risk**, and the Console is its only mitigation. It must stay one obvious click away and must never be buried. If a future change makes the full list harder to reach, that change reintroduces the risk this spec accepts.

**Tag pings are the only unprompted interruption in the product.** They are the feature most likely to be experienced as spam if the judgement is loose. The hourly ceiling is a backstop, not a substitute for the judgement being right.
