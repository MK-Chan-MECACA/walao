import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSenderNames } from "../src/sender-names.ts";

// No DB: the resolver is a pure function of the one row set it loads.
const db = {
  query: async () => ({
    rows: [
      { ref: "30558843351102@lid", name: "Sam" },
      { ref: "6591234567@c.us", name: "Siau Han" },
    ],
  }),
} as never;

test("an unnamed message borrows the name the same sender used elsewhere", async () => {
  const names = await loadSenderNames(db, "user-1");

  assert.equal(names.nameFor("30558843351102@lid", null), "Sam");
  // A name on the row itself always wins — the map is only a fallback.
  assert.equal(names.nameFor("30558843351102@lid", "Sammy"), "Sammy");
  // Unknown sender stays unresolved so the caller can fall back to the raw id.
  assert.equal(names.nameFor("99999999999@lid", null), null);
  assert.equal(names.nameFor(null, null), null);
});

test("WhatsApp mentions in the body resolve to names", async () => {
  const names = await loadSenderNames(db, "user-1");

  assert.equal(
    names.resolveMentions("@30558843351102 tell her we will refund the workshop"),
    "@Sam tell her we will refund the workshop",
  );
  assert.equal(names.resolveMentions("cc @6591234567 and @30558843351102"), "cc @Siau Han and @Sam");
  // Unknown ids and non-mention digits are left exactly as they came.
  assert.equal(names.resolveMentions("@99999999999 ping at 3pm, 30558843351102"), "@99999999999 ping at 3pm, 30558843351102");
});
