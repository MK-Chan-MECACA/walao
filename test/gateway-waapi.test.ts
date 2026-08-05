import { test } from "node:test";
import assert from "node:assert/strict";
import { WaapiGateway } from "../src/gateway/waapi.ts";

// No DB, no network: parse() is a pure wire-shape translation. The check that
// matters is that push_name survives it — with LID addressing the sender ref is
// an opaque number, so a dropped name is a permanently unnamed sender.
const gw = new WaapiGateway("http://x", "k", "http://x/hook", "s");

function messageEvent(payload: Record<string, unknown>) {
  const evt = gw.parse({
    event: "message",
    session: "walao-1",
    payload: {
      id: "m1",
      chat: "123@g.us",
      sender: "30558843351102@lid",
      timestamp: 1_754_000_000,
      body: "hi",
      ...payload,
    },
  });
  assert.equal(evt.type, "message");
  return evt as Extract<typeof evt, { type: "message" }>;
}

test("push_name is carried through parse, absent or empty means null", () => {
  assert.equal(messageEvent({ push_name: "Siti" }).senderName, "Siti");
  assert.equal(messageEvent({}).senderName, null);
  assert.equal(messageEvent({ push_name: "" }).senderName, null);
  assert.equal(messageEvent({ push_name: 42 }).senderName, null);
});
