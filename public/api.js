// The one place the app talks to the API. Every page goes through here, so
// session expiry, JSON encoding and error wording are decided once (app spec §5,
// §7). The credential is the httpOnly cookie — no page script ever holds a token.

// A failed request that is not a 401 throws this: `code` is the API's error
// string, `status` the HTTP status. Pages catch it and call message().
export class ApiError extends Error {
  constructor(code, status, body) {
    super(code);
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty or non-JSON body — `data` stays null */
  }

  // §5: one live token per Account, so a 401 means the session ended somewhere
  // else. Every page treats it the same way: back to the login screen with a
  // line saying why, rather than a screenful of failed panels.
  if (res.status === 401 && !ownsIts401()) {
    location.replace("/?expired=1");
    throw new ApiError("session_ended", 401, data);
  }
  if (!res.ok) throw new ApiError(data?.error ?? `http_${res.status}`, res.status, data);
  return data;
}

// The auth screen is already the destination, and /ops runs on the operator
// cookie, not an Account session — sending it to the login form would be a lie.
function ownsIts401() {
  return ["/", "/index.html", "/ops"].includes(location.pathname);
}

// §7: a failure says what failed in words. Unknown codes fall back to the code
// itself — a string a support conversation can work with beats "Error".
const WORDING = {
  session_ended: "Your session ended. Log in again.",
  invalid_email: "That email address doesn't look right.",
  invalid_code: "That code is wrong or has expired. Ask for a new one.",
  terms_required: "You have to accept the terms to sign up.",
  disclosure_required: "You have to affirm the disclosure before pairing.",
  attestation_required: "You have to affirm the wording before enabling a Group.",
  halted: "WALAO is paused product-wide right now. Try again later.",
  plan_limit: "Your Plan's Group limit is already reached. Disable another Group, or upgrade your Plan.",
  not_enabled: "Enable the Group before setting its summary time.",
  invalid_schedule: "That summary time or timezone isn't valid. Use a real timezone like Asia/Kuala_Lumpur.",
  invalid_question: "Ask a question in words — up to 1000 characters.",
  invalid_reminder: "That owner or due date isn't valid.",
  invalid_memory: "A Memory can't be empty.",
  invalid_candidate: "That candidate is gone — reload the page.",
  candidate_expired: "That candidate has lapsed. Its Summary aged out of the review window.",
  invalid_retention_days: "Retention has to be a whole number of days between 1 and 30.",
  invalid_opt_in: "That setting takes yes or no.",
  authorization_required: "Read and affirm the Tier 1 wording before authorising it.",
  invalid_plan: "That isn't a Plan. Pick free or pro.",
  invalid_review: "A review needs a reviewer and its verdict filled in.",
  not_found: "That's gone — reload the page.",
  bad_json: "The app sent something the server couldn't read. Reload and retry.",
  unauthorized: "You're not signed in.",
  internal: "Something broke on our side. Try again in a moment.",
};

export function message(err) {
  if (err instanceof ApiError) return WORDING[err.code] ?? `Request failed (${err.code}).`;
  return "Couldn't reach WALAO. Check your connection and retry.";
}
