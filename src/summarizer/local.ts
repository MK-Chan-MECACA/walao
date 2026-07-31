import type { SummarizerInput, SummarizerPort, SummarizerResult } from "../summarize.ts";

// Dev-only SummarizerPort. No model, no network, no API key — every line it
// emits is a verbatim message from the batch, cited to that message's own id.
// It cannot invent a claim, so the citation contract holds trivially.
//
// This exists so the pipeline downstream of the AI boundary (jobs -> summaries
// -> brief -> delivery -> item states) is runnable locally. It is NOT a
// summarizer: it does not condense, classify, or detect decisions.
//
// ponytail: swap for a real model client when one is provisioned — same port,
// one line in server.ts. Everything it returns is still forced through
// validateSummary, so the real client changes nothing downstream.
export class LocalSummarizer implements SummarizerPort {
  summarize(input: SummarizerInput): Promise<SummarizerResult> {
    return Promise.resolve({
      output: {
        highlights: input.messages.map((m) => ({
          text: m.text,
          source_message_ids: [m.id],
        })),
        decisions: [],
        action_items: [],
        dates: [],
        open_questions: [],
        memory_candidates: [],
      },
      model: "local-echo",
      promptVersion: "local-v1",
      inputTokens: 0,
      outputTokens: 0,
    });
  }
}
