// Ops one-shot: run the real Picker over a day and print what it picked next to
// everything it left behind, so a human can read the judgement by eye.
//
// Ticket 04 is a gate on that judgement, not on code. This is the tool that
// makes the gate runnable — and re-runnable after every prompt change, which is
// the whole point: the prompt is the thing being iterated on.
//
// Usage: node scripts/pick-eval.ts <user-id>              # a real day out of the DB
//        node scripts/pick-eval.ts --file day.json [name] # candidates straight from JSON
//        node scripts/pick-eval.ts --export DD/MM/YYYY "Self Name" chat.txt [chat.txt...]
//
// --export runs the real summarizer over one day of real WhatsApp chat exports
// and feeds its items to the real picker: the same two models, the same two
// prompts, the same bucket ranking as the live pipeline, on messages nobody
// wrote for a test. Exports lose mention metadata, so `tagged` is approximated
// by the self name appearing in a source message — see below.
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { loadConfig } from "../src/config.ts";
import { createPool } from "../src/db.ts";
import { BUCKETS, buildTodayBrief } from "../src/brief.ts";
import { buildCandidates, validatePick, type PickCandidate } from "../src/pick.ts";
import { AnthropicPicker } from "../src/picker/anthropic.ts";
import { AnthropicSummarizer } from "../src/summarizer/anthropic.ts";
import { validateSummary, type BatchMessage } from "../src/summarize.ts";
import { mentionsSelf } from "../src/sender-names.ts";

const config = loadConfig();
if (!config.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY is required — this evaluates the real picker");

let candidates: PickCandidate[];
let selfName: string | null;

if (process.argv[2] === "--export") {
  const [day, self, ...files] = process.argv.slice(3);
  if (!day || !self || files.length === 0) {
    throw new Error('usage: --export DD/MM/YYYY "Self Name" chat.txt [chat.txt...]');
  }
  selfName = self;
  candidates = [];
  const summarizer = new AnthropicSummarizer(config.anthropicApiKey);
  // Exports render a mention as "@Name" with the name wrapped in isolate marks,
  // which parseExport strips — so mentionsSelf is the same rule the live path
  // applies, on the same shape of text.
  const identity = { name: self, phone: null, lid: null };

  for (const file of files) {
    const group = basename(file).replace(/^WhatsApp Chat with /, "").replace(/\.txt$/, "");
    const messages = parseExport(readFileSync(file, "utf8"), group).filter((m) => m.sent_at.startsWith(isoDay(day)));
    if (messages.length === 0) {
      console.error(`${group}: no messages on ${day}`);
      continue;
    }
    const result = await summarizer.summarize({ language: "en", messages });
    const payload = validateSummary(result.output, new Set(messages.map((m) => m.id)));
    const byId = new Map(messages.map((m) => [m.id, m.text]));
    console.error(`${group}: ${messages.length} messages → summarized`);

    for (const [section, bucket] of BUCKETS) {
      payload[section].forEach((item, i) => {
        candidates.push({
          key: `${group}|${section}|${i}`,
          text: item.text,
          group_name: group,
          bucket,
          tagged:
            item.source_message_ids.some((id) => mentionsSelf(byId.get(id) ?? "", identity)) ||
            mentionsSelf(item.text, identity),
        });
      });
    }
  }
  // Summarizing a day costs a call and is not deterministic, so iterating the
  // picker prompt on a fixed day means keeping the day: dump it, then re-run
  // with --file until the pick is right.
  if (process.env.PICK_EVAL_DUMP) writeFileSync(process.env.PICK_EVAL_DUMP, JSON.stringify(candidates, null, 1));
} else if (process.argv[2] === "--file") {
  // Each entry is a candidate as the picker sees one; `key` defaults to its
  // position so a hand-written day does not have to invent summary ids.
  const raw = JSON.parse(readFileSync(process.argv[3] ?? "", "utf8")) as Partial<PickCandidate>[];
  candidates = raw.map((c, i) => ({
    key: c.key ?? String(i),
    text: c.text ?? "",
    group_name: c.group_name ?? null,
    bucket: c.bucket ?? "worth_noting",
    tagged: c.tagged ?? false,
  }));
  selfName = process.argv[4] ?? null;
} else {
  const userId = process.argv[2];
  if (!userId) throw new Error("usage: node scripts/pick-eval.ts <user-id> | --file day.json [name]");
  const pool = createPool(config.databaseUrl);
  const brief = await buildTodayBrief(pool, userId);
  ({ candidates, selfName } = await buildCandidates(pool, config, userId, brief));
  await pool.end();
}

if (candidates.length === 0) {
  console.log("no candidates — a day with nothing in it never reaches the model");
  process.exit(0);
}

const result = await new AnthropicPicker(config.anthropicApiKey).pick({ candidates, self_name: selfName });
const pick = validatePick(result.output, new Set(candidates.map((c) => c.key)));

console.log(`model=${result.model} prompt=${result.promptVersion} self=${selfName ?? "unknown"}`);
console.log(`items=${candidates.length} picked=${pick.keys.length}`);
console.log(`\nheadline: ${pick.headline || "(empty)"}\n`);

const picked = new Set(pick.keys);
for (const c of candidates) {
  console.log(
    `${picked.has(c.key) ? "PICK" : "  · "} [${c.bucket}${c.tagged ? " tagged" : ""}] ${c.group_name ?? "?"}: ${c.text}`,
  );
}

// WhatsApp's own export format, Android flavour:
//   "06/08/2026, 4:41 pm - MK Chan: text", continuation lines belong to the
// message above, and a line with no "Sender: " is a system notice (added,
// created group, encryption banner) — not a message, so it is dropped.
function parseExport(text: string, group: string): BatchMessage[] {
  const head = /^(\d{2})\/(\d{2})\/(\d{4}), (\d{1,2}):(\d{2})[\s ]?([ap])m - (.*)$/i;
  const messages: BatchMessage[] = [];
  // Isolate marks around a mentioned name (U+2068/U+2069) are export-only
  // decoration; stripping them leaves the "@Name" the live pipeline sees.
  for (const line of text.replace(/[⁨⁩]/g, "").split("\n")) {
    const m = head.exec(line);
    if (!m) {
      const last = messages.at(-1);
      if (last) last.text += `\n${line}`;
      continue;
    }
    const [, d, mo, y, h, min, ap, rest] = m;
    const colon = rest!.indexOf(": ");
    if (colon === -1) continue;
    const hour = (Number(h) % 12) + (ap!.toLowerCase() === "p" ? 12 : 0);
    messages.push({
      id: `${group}-${messages.length}`,
      sender_ref: null,
      sender_name: rest!.slice(0, colon),
      // ponytail: exports carry no offset, so the account's own zone is assumed.
      sent_at: `${y}-${mo}-${d}T${String(hour).padStart(2, "0")}:${min}:00+08:00`,
      text: rest!.slice(colon + 2),
    });
  }
  return messages;
}

// DD/MM/YYYY as it appears in the export → the YYYY-MM-DD prefix of sent_at.
function isoDay(day: string): string {
  const [d, m, y] = day.split("/");
  return `${y}-${m}-${d}`;
}
