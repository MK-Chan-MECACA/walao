import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_PICK, validatePick, type PickCandidate } from "../src/pick.ts";
import { mentionsSelf } from "../src/sender-names.ts";
import { LocalPicker } from "../src/picker/local.ts";
import { PICK_SCHEMA, pickSystemPrompt, pickUserPrompt } from "../src/picker/anthropic.ts";

const SELF = { phone: "60123456789@s.whatsapp.net", lid: "112476687458485@lid", name: "MK Chan" };

describe("mentionsSelf", () => {
  it("matches a mention written as the phone digits", () => {
    assert.equal(mentionsSelf("@60123456789 please confirm", SELF), true);
  });

  it("matches a mention written as the LID digits", () => {
    assert.equal(mentionsSelf("@112476687458485 can you check this", SELF), true);
  });

  it("matches a device-suffixed identity against the bare mention", () => {
    const self = { phone: null, lid: "112476687458485:90@lid", name: null };
    assert.equal(mentionsSelf("thanks @112476687458485", self), true);
  });

  it("does not match a different person's mention", () => {
    assert.equal(mentionsSelf("@60999888777 handle this", SELF), false);
  });

  it("does not match digits that are not a mention", () => {
    assert.equal(mentionsSelf("call 60123456789 later", SELF), false);
  });

  it("does not match a longer id that merely starts with ours", () => {
    assert.equal(mentionsSelf("@601234567891234 look", SELF), false);
  });

  // Past raw expiry the only text left is the Summary item, where the digits
  // have already been rewritten to the display name.
  it("matches the resolved @Name left in an item text", () => {
    assert.equal(mentionsSelf("@MK Chan asked for the banner", SELF), true);
    assert.equal(mentionsSelf("@Lee Yee asked for the banner", SELF), false);
  });

  it("is false when the identity is unknown", () => {
    assert.equal(mentionsSelf("@60123456789 hello", null), false);
    assert.equal(mentionsSelf("@MK Chan hello", { phone: null, lid: null, name: null }), false);
  });
});

const VALID = new Set(["a", "b", "c", "d", "e", "f", "g"]);

describe("validatePick", () => {
  it("keeps the headline and the keys the model was actually given", () => {
    const pick = validatePick({ headline: "Two things need you", keys: ["a", "c"] }, VALID);
    assert.deepEqual(pick, { headline: "Two things need you", keys: ["a", "c"] });
  });

  it("drops keys that were never candidates", () => {
    assert.deepEqual(validatePick({ headline: "x", keys: ["a", "invented", "b"] }, VALID).keys, [
      "a",
      "b",
    ]);
  });

  it("dedupes repeated keys", () => {
    assert.deepEqual(validatePick({ headline: "x", keys: ["a", "a", "b"] }, VALID).keys, ["a", "b"]);
  });

  it("caps the pick at MAX_PICK however many the model returns", () => {
    const pick = validatePick({ headline: "x", keys: ["a", "b", "c", "d", "e", "f", "g"] }, VALID);
    assert.equal(pick.keys.length, MAX_PICK);
    assert.deepEqual(pick.keys, ["a", "b", "c", "d", "e"]);
  });

  it("an empty pick is valid — a quiet day is the point", () => {
    assert.deepEqual(validatePick({ headline: "", keys: [] }, VALID), { headline: "", keys: [] });
  });

  it("garbage in, empty pick out", () => {
    assert.deepEqual(validatePick(null, VALID), { headline: "", keys: [] });
    assert.deepEqual(validatePick("nope", VALID), { headline: "", keys: [] });
    assert.deepEqual(validatePick({ keys: "a" }, VALID), { headline: "", keys: [] });
  });

  it("truncates a runaway headline rather than shipping it", () => {
    assert.equal(validatePick({ headline: "x".repeat(400), keys: [] }, VALID).headline.length, 200);
  });

  it("discards a non-string headline without discarding the keys", () => {
    assert.deepEqual(validatePick({ headline: 42, keys: ["a"] }, VALID), {
      headline: "",
      keys: ["a"],
    });
  });
});

function candidate(over: Partial<PickCandidate> = {}): PickCandidate {
  return {
    key: "s1|action_items|0",
    text: "Pay the vendor",
    group_name: "Purchasing",
    bucket: "needs_action",
    tagged: false,
    ...over,
  };
}

describe("LocalPicker", () => {
  it("prefers tagged needs-action items", async () => {
    const res = await new LocalPicker().pick({
      self_name: "MK",
      candidates: [candidate({ key: "a" }), candidate({ key: "b", tagged: true })],
    });
    assert.equal(validatePick(res.output, new Set(["a", "b"])).keys[0], "b");
  });

  it("never returns more than MAX_PICK", async () => {
    const candidates = Array.from({ length: 20 }, (_, i) =>
      candidate({ key: `k${i}`, tagged: true }),
    );
    const res = await new LocalPicker().pick({ self_name: null, candidates });
    assert.equal(validatePick(res.output, new Set(candidates.map((c) => c.key))).keys.length, MAX_PICK);
  });

  it("returns nothing when there is nothing in needs_action", async () => {
    const res = await new LocalPicker().pick({
      self_name: null,
      candidates: [candidate({ key: "a", bucket: "worth_noting" })],
    });
    assert.deepEqual(validatePick(res.output, new Set(["a"])).keys, []);
  });
});

const CANDIDATES: PickCandidate[] = [
  candidate({ key: "s1|action_items|0", text: "Change the banner", group_name: "LEAD Marketing" }),
  candidate({
    key: "s2|open_questions|1",
    text: "Lee Yee asked whether the utility format is OK",
    group_name: "LEAD Content",
    tagged: true,
  }),
];

// The rules that carry product meaning, not the wording around them.
describe("picker prompt", () => {
  it("names the user when known, and says nothing about null when not", () => {
    assert.match(pickSystemPrompt("MK Chan"), /MK Chan/);
    assert.doesNotMatch(pickSystemPrompt(null), /null/);
  });

  it("states the rules the product depends on", () => {
    const p = pickSystemPrompt("MK");
    assert.match(p, /thank/i); // being thanked needs nothing
    assert.match(p, /empty/i); // an empty pick is correct
    assert.match(p, /at most 5/i); // the cap, also enforced in code
    assert.match(p, /Never invent one/); // only keys you were given
  });

  it("puts candidates inside a delimiter as untrusted data", () => {
    const user = pickUserPrompt(CANDIDATES);
    assert.match(user, /^<items>/);
    assert.match(user, /<\/items>$/);
    assert.match(pickSystemPrompt(null), /untrusted user data/);
  });

  it("carries the key, the group and the tagged flag for every candidate", () => {
    const user = pickUserPrompt(CANDIDATES);
    assert.match(user, /key=s1\|action_items\|0/);
    assert.match(user, /group=LEAD Marketing/);
    assert.match(user, /tagged=true/);
    assert.match(user, /tagged=false/);
  });

  it("constrains output to a headline and a key list", () => {
    assert.deepEqual(PICK_SCHEMA.required, ["headline", "keys"]);
    assert.equal(PICK_SCHEMA.additionalProperties, false);
  });
});
