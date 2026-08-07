# Picker validation — is the day's pick good enough to push to a phone?

Ticket 04 of the Calm Today Pick line is a gate, not a feature. Everything
downstream — the daily message, the cadence work, the tag pings — rests on the
Picker separating *"MK please fix this"* from *"thanks MK"*. That distinction is
the product. This is the record of testing it against real days.

Run on 2026-08-07 against `picker-v1`, which this exercise moved to `picker-v2`.

## What was run

Real WhatsApp chat exports of three of the Account holder's own working groups,
covering March–August 2026. Not fixtures: nobody wrote these messages for a
test, and the Picker had never seen them.

Each run goes through the same two models and the same two prompts as
production — the real `AnthropicSummarizer` extracts the day's items, the real
bucket ranking sorts them, the real `AnthropicPicker` chooses. Only the source
of the messages differs: an export file rather than the ingest pipeline. The
harness is `scripts/pick-eval.ts`.

| Day | Groups | Messages | Items | Picked |
|---|---|---|---|---|
| 2026-03-25 | 1 | 62 | 26 | 2 |
| 2026-03-27 | 1 | 51 | 21 | 3 |
| 2026-07-21 (quiet) | 1 | 4 | 1 | 0 |
| 2026-07-30 | 1 | 101 | 20 | 1 |
| 2026-07-30 | **3** | **214** | **69** | **1** |
| 2026-08-02 | 1 | 118 | 37 | 1 |

Plus one targeted probe of the praise rule: nine candidates whose text is
verbatim real messages, packaged directly as candidates so the judgement under
test is the Picker's own and not the Summarizer's filtering.

Exports carry mentions as `@Name` wrapped in isolate marks; the parser strips
those, so `mentionsSelf` applies the same rule to the same shape of text as the
live path. One thing the export cannot reproduce: mentions written as a bare
phone or LID, which the live path resolves through the stored identity.

## What it got right

**A direct ask is picked.** On the three-group day, 69 items competing, it
returned exactly one: an urgent request naming the Account holder and asking him
to send something. That is the message a person would have wanted from that day.

**Praise is not picked, even tagged.** All four thanks/congratulation messages
in the probe were left behind, including three that @mention the Account holder.
Upstream, the Summarizer usually does not emit praise as an item at all, so in
the live pipeline the property holds twice over — but the Picker's own rule was
verified directly rather than assumed.

**Being named is not being asked.** A tagged item reporting that somebody had
finished a piece of work — an FYI addressed to the Account holder — was not
picked. Nor was a request that named him while addressing the work to a
colleague. Nor was a question he himself had asked the group.

**Somebody else's deadline stays theirs.** The third group's day was full of
same-day, time-boxed commitments belonging to operations staff. None were
picked. Time pressure alone does not promote an item; it has to be the
Account holder's.

**A quiet day is empty.** Four messages, one item, no pick, empty headline. No
padding.

## Disagreements, and what changed

**The day's own deadlines were dropped.** On 2026-08-02, `picker-v1` returned
one item — a question asked of the Account holder — and left behind a same-day
task in the area he owns, where the day itself said the deadline was that night.
A human reading all 118 messages picks both. The Account holder confirmed the
human reading.

Added to the prompt: return an item the person owns that runs out of time today
or tomorrow, even when nobody asked them for it directly.

The first wording of that rule was too loose. It carried the deadline items but
also started returning work the group had given to somebody else — three
over-picks across two days. The rule now requires ownership to be evident from
the items themselves, and to leave the item alone where the day shows nothing
either way. On re-run, the over-picks were gone and the deadline items stayed.

**The headline described the user instead of speaking to them.** Half the
headlines came back in the third person — *"MK Chan needs to fix…"* — which
reads like a status report about somebody, not a message to them. On a web page
that is merely stiff; arriving on a phone it is wrong. The prompt now asks for a
headline addressed to the person as "you", and forbids the third person.

Both rules are covered by tests in `test/pick.test.ts`.

## The known weak point

The Picker's judgement is only as good as what the Summarizer hands it, and the
Summarizer is not deterministic about *who was addressed*. The same 118 messages
summarized twice produced, for the same conversation, `"Dr. Lau asked MK Chan
whether …"` on one run and `"Dr. Lau asked whether …"` on another. With the
addressee preserved the item is picked; with it dropped the Picker correctly
declines an unaddressed question, and the day's most important item is missed.

Two things make this smaller than it looks. Where the group @mentions people,
`tagged` carries the addressee deterministically, computed in code and never
inferred. And where it does not, this is a miss — a quiet day that should not
have been quiet — not a wrong item pushed to a phone.

It is still the biggest remaining source of a wrong pick, and it lives upstream
of the Picker. Worth revisiting if the daily message reads as too quiet.

## Verdict

**Yes — reliable enough to push to a phone.**

Across six real days and a targeted probe, the Picker did not once return
something that merely thanked, congratulated, or informed the Account holder,
and did not once return work the group had given to somebody else. On the
crowded three-group day it found the single genuine ask among 69 items. The
distinction the whole feature rests on holds.

The failure mode that survives is under-picking, not over-picking. That is the
right way round for something that arrives unasked on a phone: a day that was
quieter than it should have been costs a missed item the web page still shows,
where a day padded with somebody else's work costs the app being muted.

Tickets 06 and 08 are unblocked.
