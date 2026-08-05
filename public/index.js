import { api, message } from "/api.js";

const $ = (id) => document.getElementById(id);
const formEmail = $("form-email");
const formCode = $("form-code");
const error = $("error");
let mode = "signup";
let terms = null;

// §5: api.js redirects here with ?expired=1 when a session stops working.
if (new URLSearchParams(location.search).has("expired")) {
  $("notice").textContent = "Your session ended. Log in again.";
  $("notice").hidden = false;
  setMode("login");
}

api("GET", "/v1/terms")
  .then((t) => {
    terms = t;
    $("terms-text").textContent = t.text;
    $("terms-version").textContent = `version ${t.version}`;
  })
  .catch((err) => {
    $("terms-text").textContent = message(err);
  });

function setMode(next) {
  mode = next;
  $("tab-signup").setAttribute("aria-pressed", String(next === "signup"));
  $("tab-login").setAttribute("aria-pressed", String(next === "login"));
  $("terms-box").hidden = next === "login";
  error.hidden = true;
}

$("tab-signup").onclick = () => setMode("signup");
$("tab-login").onclick = () => setMode("login");

function fail(err) {
  error.textContent = typeof err === "string" ? err : message(err);
  error.hidden = false;
}

formEmail.onsubmit = async (e) => {
  e.preventDefault();
  error.hidden = true;
  const email = $("email").value.trim();
  if (mode === "signup" && !$("terms-ok").checked) {
    fail("You have to accept the terms to sign up.");
    return;
  }
  const button = $("send-code");
  button.disabled = true;
  try {
    if (mode === "signup") {
      await api("POST", "/v1/signup", { email, terms_version: terms?.version });
    } else {
      await api("POST", "/v1/login", { email });
    }
    $("code-email").textContent = email;
    formEmail.hidden = true;
    formCode.hidden = false;
    $("code").focus();
  } catch (err) {
    fail(err);
  } finally {
    button.disabled = false;
  }
};

formCode.onsubmit = async (e) => {
  e.preventDefault();
  error.hidden = true;
  try {
    // The token comes back in the body for API clients; the browser's copy
    // is the httpOnly cookie set alongside it, which this script cannot read.
    await api("POST", "/v1/verify", {
      email: $("code-email").textContent,
      code: $("code").value.trim(),
    });
    location.href = "/pair";
  } catch (err) {
    fail(err);
  }
};

$("back").onclick = () => {
  formCode.hidden = true;
  formEmail.hidden = false;
  error.hidden = true;
};
