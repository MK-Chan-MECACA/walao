import { MAX_PICK, type PickerInput, type PickerPort, type PickerResult } from "../pick.ts";

// Deterministic fallback for a deployment with no ANTHROPIC_API_KEY, matching
// LocalSummarizer and LocalAnswerer: the pipeline stays runnable with no AI
// spend, on an identical port.
//
// The rule is the crudest thing that is still honest — tagged needs-action
// items first, then the rest of needs_action, capped. It cannot tell "MK please
// fix this" from "thanks MK", which is exactly why it is the fallback and not
// the product.
export class LocalPicker implements PickerPort {
  pick(input: PickerInput): Promise<PickerResult> {
    const actionable = input.candidates.filter((c) => c.bucket === "needs_action");
    const ranked = [
      ...actionable.filter((c) => c.tagged),
      ...actionable.filter((c) => !c.tagged),
    ].slice(0, MAX_PICK);
    return Promise.resolve({
      output: {
        headline: ranked.length === 0 ? "" : `${ranked.length} thing(s) need you.`,
        keys: ranked.map((c) => c.key),
      },
      model: "local-echo",
      promptVersion: "picker-local-v1",
    });
  }
}
