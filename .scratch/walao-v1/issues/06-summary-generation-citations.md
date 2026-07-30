# 06 — Summary generation with citation contract

**What to build:** A scheduled summary job takes the group's message batch through deterministic cleaning, then through the SummarizerPort (which holds no tool access), and produces a structured summary: highlights, decisions, action items, dates, open questions, and memory candidates, each item carrying source-message references. Claims without at least one valid source are dropped. Quiet input yields "nothing happened", never invented content; unknowns stay "I don't know". Hostile message text cannot alter output structure or trigger anything. Model, prompt version, token usage, and generation time are recorded per summary with no raw chat in routine logs. This establishes the AI-pipeline test seam: batch + config in, structured JSON out.

The output schema is locked (decision from the README, carried through the spec):

```json
{
  "highlights": [{"text": "...", "source_message_ids": ["..."]}],
  "decisions": [{"text": "...", "source_message_ids": ["..."]}],
  "action_items": [{"text": "...", "owner": null, "due_at": null, "confidence": 0.0, "source_message_ids": ["..."]}],
  "dates": [], "open_questions": [], "memory_candidates": []
}
```

**Blocked by:** 05 — Scheduler.

**Status:** ready-for-agent

- [ ] A summary job produces output conforming to the locked schema; every item carries ≥1 valid source-message reference or is dropped
- [ ] Quiet/empty input produces an explicit "nothing happened" result with zero fabricated items
- [ ] Prompt-injection test: hostile message content does not change output structure or escape the data role
- [ ] Output language follows the group's configured language (ZH/EN/MS) regardless of input language mix
- [ ] Per-summary metrics (model, prompt version, tokens, duration) recorded; routine logs contain no message bodies
- [ ] Whole-system path works end to end with a fake SummarizerPort returning canned JSON
