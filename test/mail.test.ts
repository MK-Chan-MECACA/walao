import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEmail, resendSender } from "../src/mail.ts";

// No DB, no network, no key. What matters at this boundary: the code reaches
// the right mailbox, and a rejected send is loud rather than silently "sent".

test("the code goes to the requesting address, in body and subject", () => {
  const mail = buildEmail("WALAO <no-reply@walao.app>", "merchant@example.com", "K7QM4XPD");
  assert.deepEqual(mail.to, ["merchant@example.com"]);
  assert.equal(mail.from, "WALAO <no-reply@walao.app>");
  assert.match(mail.subject, /K7QM4XPD/);
  assert.match(mail.text, /K7QM4XPD/);
});

test("sends one authenticated POST carrying the code", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const send = resendSender("re_test_key", "WALAO <no-reply@walao.app>", (async (url, init) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return new Response("{}", { status: 200 });
  }) as typeof fetch);

  await send("merchant@example.com", "K7QM4XPD");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.equal(calls[0].init.method, "POST");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer re_test_key");
  const body = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(body.to, ["merchant@example.com"]);
  assert.match(body.text, /K7QM4XPD/);
});

test("a rejected send throws instead of reporting success", async () => {
  // The user is told "check your email" off the back of this resolving. If an
  // unverified domain or a dead key silently resolved, they would wait forever.
  const send = resendSender("re_test_key", "WALAO <no-reply@walao.app>", (async () =>
    new Response('{"message":"domain is not verified"}', { status: 403 })) as typeof fetch);

  await assert.rejects(
    () => send("merchant@example.com", "K7QM4XPD"),
    /resend 403: .*domain is not verified/,
  );
});
