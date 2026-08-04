import type { SendCode } from "./accounts.ts";

// Resend adapter — the only module that knows how a login code reaches a human.
//
// No SDK: the entire surface we need is one POST, so a fetch call is the whole
// integration. Failure throws rather than resolving, because a code we did not
// deliver must not be reported to the caller as sent — the user would sit
// waiting for mail that is never coming.

const ENDPOINT = "https://api.resend.com/emails";
const TIMEOUT_MS = 10_000;

export function buildEmail(from: string, to: string, code: string) {
  return {
    from,
    to: [to],
    subject: `${code} is your WALAO sign-in code`,
    text: [
      `Your WALAO sign-in code is ${code}`,
      "",
      "It expires in 15 minutes.",
      "If you did not ask to sign in, ignore this email — nothing has changed.",
    ].join("\n"),
  };
}

export function resendSender(
  apiKey: string,
  from: string,
  fetchImpl: typeof fetch = fetch,
): SendCode {
  return async (email, code) => {
    const res = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(buildEmail(from, email, code)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      // Body, not just status: Resend puts the actionable part (unverified
      // domain, bad from address) in the message. Truncated so a chatty error
      // page cannot flood the log.
      const detail = await res.text().catch(() => "");
      throw new Error(`resend ${res.status}: ${detail.slice(0, 300)}`);
    }
  };
}
