import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSummary } from "../src/summarize.ts";
import { LocalSummarizer } from "../src/summarizer/local.ts";

// No DB: the local summarizer is a pure function of the batch. The check that
// matters is that everything it emits survives validateSummary — i.e. it cannot
// produce an uncited claim, which is what lets it stand in for a real model.
test("local summarizer emits only verbatim, self-cited claims", async () => {
  const messages = [
    { id: "11111111-1111-1111-1111-111111111111", sender_ref: "a@c.us", sender_name: null, sent_at: "2026-07-31T00:00:00.000Z", text: "lunch at 1pm" },
    { id: "22222222-2222-2222-2222-222222222222", sender_ref: null, sender_name: null, sent_at: "2026-07-31T00:01:00.000Z", text: "bring the invoice" },
  ];

  const res = await new LocalSummarizer().summarize({ language: "en", messages });
  const payload = validateSummary(res.output, new Set(messages.map((m) => m.id)));

  // Nothing is dropped by validation => every claim carried a valid citation.
  assert.equal(payload.highlights.length, messages.length);
  for (const [i, h] of payload.highlights.entries()) {
    assert.equal(h.text, messages[i].text); // verbatim, not invented
    assert.deepEqual(h.source_message_ids, [messages[i].id]);
  }
  // It classifies nothing — those sections are a real model's job.
  assert.deepEqual(payload.decisions, []);
  assert.deepEqual(payload.action_items, []);

  // Zero-cost, and identifiable in the summaries table.
  assert.equal(res.model, "local-echo");
  assert.equal(res.inputTokens, 0);
});

test("empty batch produces an empty summary, not invented content", async () => {
  const res = await new LocalSummarizer().summarize({ language: "en", messages: [] });
  assert.deepEqual(validateSummary(res.output, new Set()), {
    highlights: [],
    decisions: [],
    action_items: [],
    dates: [],
    open_questions: [],
    memory_candidates: [],
  });
});
