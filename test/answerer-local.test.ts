import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAnswer, type AskSource } from "../src/ask.ts";
import { LocalAnswerer } from "../src/answerer/local.ts";

// No DB: the local answerer is a pure function of what retrieval found. The
// check that matters is that everything it emits survives validateAnswer — it
// cannot produce an uncited claim, which is what lets it stand in for a model.
test("local answerer emits only verbatim, self-cited claims", async () => {
  const sources: AskSource[] = [
    { id: "11111111-1111-1111-1111-111111111111", kind: "message", text: "deposit RM500 paid" },
    { id: "22222222-2222-2222-2222-222222222222", kind: "summary", text: "supplier confirmed" },
  ];

  const res = await new LocalAnswerer().answer({ question: "was the deposit paid?", sources });
  const answer = validateAnswer(res.output, new Set(sources.map((s) => s.id)));

  assert.equal(answer.answered, true);
  assert.equal(answer.claims.length, sources.length); // nothing dropped => all cited
  for (const [i, claim] of answer.claims.entries()) {
    assert.equal(claim.text, sources[i].text); // verbatim, not invented
    assert.deepEqual(claim.source_ids, [sources[i].id]);
  }
  assert.equal(res.model, "local-echo");
});

test("nothing retrieved is \"I don't know\", never a guess", async () => {
  const res = await new LocalAnswerer().answer({ question: "what is the margin?", sources: [] });
  assert.deepEqual(validateAnswer(res.output, new Set()), {
    answered: false,
    answer: "I don't know",
    claims: [],
  });
});
