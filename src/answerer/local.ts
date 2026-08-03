import type { AnswererInput, AnswererPort, AnswererResult } from "../ask.ts";

// Dev-only AnswererPort, the mirror of LocalSummarizer. No model, no network,
// no API key — every claim it emits is a verbatim retrieved source, cited to
// that source's own id, so the citation contract holds trivially.
//
// It does not answer the question; it hands back what retrieval found. When
// retrieval finds nothing, ask.ts never calls the port at all and the user gets
// "I don't know" — that path is structural, not a judgement made here.
//
// ponytail: swap for AnthropicAnswerer when a key is provisioned — same port,
// one line in server.ts, and validateAnswer still owns the shape either way.
export class LocalAnswerer implements AnswererPort {
  answer(input: AnswererInput): Promise<AnswererResult> {
    return Promise.resolve({
      output: { claims: input.sources.map((s) => ({ text: s.text, source_ids: [s.id] })) },
      model: "local-echo",
      promptVersion: "local-v1",
    });
  }
}
