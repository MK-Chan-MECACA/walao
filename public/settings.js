import { api, message } from "/api.js";
import { el, fmtDate, mount } from "/layout.js";

const $ = (id) => document.getElementById(id);
const KINDS = {
  data_processing_terms: "Data-processing terms",
  ban_risk: "Pairing and ban risk",
  group_responsibility: "Group responsibility",
  tier1_outbound: "Tier 1 outbound",
  group_disabled: "Group disabled",
};

const status = await mount("/settings");
// ponytail: `paused` is read off the status block, and `halted`/`unpaid`
// outrank it there — an Account paused during a product-wide halt reads as
// not paused until the halt clears. Add `paused` to GET /v1/status if that
// ever bites.
let paused = status?.block?.reason === "paused";

renderPause();
loadUsage();
loadDigest();
loadRetention();
loadQuality();
loadAttestations();

function fail(err) {
  $("error").textContent = message(err);
  $("error").hidden = false;
}

// §44, §45: Plan, burn against caps, Trial state and the expensive Groups,
// all from the one usage route.
async function loadUsage() {
  let usage;
  try {
    usage = await api("GET", "/v1/usage");
  } catch (err) {
    $("plan").textContent = message(err);
    return;
  }
  $("plan").textContent = `You are on the ${usage.plan} Plan.`;
  if (usage.trial) {
    $("trial").textContent = `Trial: ${usage.trial.days_remaining} day(s) left, ends ${fmtDate(usage.trial.ends_at)}.`;
    $("trial").hidden = false;
  }
  $("caps").replaceChildren(
    capRow("Groups enabled", usage.usage.enabled_groups, usage.limits.max_groups),
    capRow("Messages today", usage.usage.messages_today, usage.limits.max_messages_per_day),
    capRow("Summaries today", usage.usage.credits_today, usage.limits.max_summaries_per_day),
  );
  $("fix-cap").hidden = usage.usage.enabled_groups <= usage.limits.max_groups;
  $("burn").replaceChildren(
    ...(usage.groups.length
      ? usage.groups.map((g) =>
          el(
            "li",
            {},
            el("span", { class: "grow", text: g.name ?? g.group_id }),
            el("span", { class: "muted", text: `${g.credits_30d} credit(s)` }),
          ),
        )
      : [el("li", { class: "muted", text: "No Summary written in the last 30 days." })]),
  );
  $("cancel-box").hidden = usage.plan === "free";
}

function capRow(label, used, limit) {
  return el(
    "li",
    { class: used >= limit ? "blocked" : null },
    el("span", { class: "grow", text: label }),
    el("span", { class: "muted", text: `${used} of ${limit}` }),
  );
}

$("cancel").onclick = async () => {
  $("cancel").disabled = true;
  $("error").hidden = true;
  try {
    await api("POST", "/v1/plan/cancel");
    loadUsage();
  } catch (err) {
    fail(err);
  }
  $("cancel").disabled = false;
};

// §48: one control, immediate and reversible.
function renderPause() {
  $("pause-line").textContent = paused
    ? "Processing is paused. Nothing is ingested or summarised while it is."
    : "WALAO is processing normally.";
  $("pause").textContent = paused ? "Resume processing" : "Pause processing";
  $("pause").hidden = false;
}

$("pause").onclick = async () => {
  $("pause").disabled = true;
  $("error").hidden = true;
  try {
    const res = await api("POST", paused ? "/v1/resume" : "/v1/pause", {});
    paused = res.paused;
    renderPause();
    await mount("/settings"); // the banner changes with it
  } catch (err) {
    fail(err);
  }
  $("pause").disabled = false;
};

// Ticket 6: when the one daily message arrives. The zone list comes from the
// browser's own tz database — the same one the server validates against — so
// there is no list to ship or keep current.
async function loadDigest() {
  let digest;
  try {
    digest = await api("GET", "/v1/digest");
  } catch (err) {
    fail(err);
    return;
  }
  const zones = Intl.supportedValuesOf?.("timeZone") ?? [digest.timezone];
  if (!zones.includes(digest.timezone)) zones.unshift(digest.timezone);
  $("digest-tz").replaceChildren(
    ...zones.map((z) => el("option", { value: z, text: z, selected: z === digest.timezone })),
  );
  $("digest-time").value = digest.digest_time;
}

$("save-digest").onclick = async () => {
  $("save-digest").disabled = true;
  $("error").hidden = true;
  try {
    const res = await api("PUT", "/v1/digest", {
      digest_time: $("digest-time").value,
      timezone: $("digest-tz").value,
    });
    $("digest-time").value = res.digest_time;
  } catch (err) {
    fail(err);
  }
  $("save-digest").disabled = false;
};

// §47: 1 to 30 days, the merchant's decision.
async function loadRetention() {
  try {
    $("retention").value = (await api("GET", "/v1/retention")).retention_days;
  } catch (err) {
    fail(err);
  }
}

$("save-retention").onclick = async () => {
  $("save-retention").disabled = true;
  $("error").hidden = true;
  try {
    const res = await api("PUT", "/v1/retention", {
      retention_days: Number($("retention").value),
    });
    $("retention").value = res.retention_days;
  } catch (err) {
    fail(err);
  }
  $("save-retention").disabled = false;
};

async function loadQuality() {
  try {
    $("quality").checked = (await api("GET", "/v1/quality-review")).opt_in;
    $("quality").disabled = false;
  } catch (err) {
    fail(err);
  }
}

$("quality").onchange = async (e) => {
  e.target.disabled = true;
  $("error").hidden = true;
  try {
    e.target.checked = (await api("PUT", "/v1/quality-review", { opt_in: e.target.checked }))
      .opt_in;
  } catch (err) {
    e.target.checked = !e.target.checked;
    fail(err);
  }
  e.target.disabled = false;
};

// §52 and §53 share a source: the Attestation list is both the consent
// record and how the page knows Tier 1 is already authorised.
async function loadAttestations() {
  let list;
  try {
    list = (await api("GET", "/v1/attestations")).attestations;
  } catch (err) {
    $("attestations").replaceChildren(el("li", { class: "muted", text: message(err) }));
    return;
  }
  $("attestations").replaceChildren(
    ...(list.length
      ? list.map((a) =>
          el(
            "li",
            {},
            el(
              "div",
              { class: "grow" },
              el("strong", { text: KINDS[a.kind] ?? a.kind }),
              el("span", {
                class: "muted",
                text: ` version ${a.version ?? "—"} · ${fmtDate(a.created_at)}`,
              }),
            ),
            a.text
              ? el(
                  "details",
                  {},
                  el("summary", { text: "What you agreed to" }),
                  el("div", { class: "sources" }, el("p", { text: a.text })),
                )
              : null,
          ),
        )
      : [el("li", { class: "muted", text: "Nothing affirmed yet." })]),
  );
  renderTier1(list.some((a) => a.kind === "tier1_outbound"));
}

async function renderTier1(enabled) {
  if (enabled) {
    $("tier1-state").textContent =
      "Tier 1 is authorised. WALAO may send from your number, one consent message per new recipient first.";
    return;
  }
  $("tier1-state").textContent = "Tier 1 is off. WALAO sends nothing from your number.";
  let texts;
  try {
    texts = await api("GET", "/v1/attestation-texts");
  } catch (err) {
    $("tier1-state").textContent = message(err);
    return;
  }
  const wording = texts.tier1_outbound;
  $("tier1-text").textContent = wording.text;
  $("tier1-version").textContent = `version ${wording.version}`;
  $("tier1-box").hidden = false;
  $("tier1-ok").onchange = (e) => {
    $("tier1").disabled = !e.target.checked;
  };
  $("tier1").onclick = async () => {
    $("tier1").disabled = true;
    $("error").hidden = true;
    try {
      await api("POST", "/v1/tier1", { authorization_version: wording.version });
      $("tier1-box").hidden = true;
      loadAttestations();
    } catch (err) {
      $("tier1").disabled = false;
      fail(err);
    }
  };
}

// §49: leaving is possible — the whole export, as a file.
$("export").onclick = async () => {
  $("export").disabled = true;
  $("error").hidden = true;
  try {
    const data = await api("GET", "/v1/export");
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    );
    // Not revoked: the blob dies with the page, and revoking here races
    // the browser's own read of it.
    el("a", { href: url, download: "walao-export.json" }).click();
  } catch (err) {
    fail(err);
  }
  $("export").disabled = false;
};

// §50: an irreversible act is never one stray tap.
$("confirm").oninput = (e) => {
  $("delete").disabled = e.target.value !== "DELETE";
};

$("delete").onclick = async () => {
  $("delete").disabled = true;
  $("error").hidden = true;
  try {
    await api("DELETE", "/v1/account");
    location.replace("/");
  } catch (err) {
    $("delete").disabled = false;
    fail(err);
  }
};

// §4: a log-out that ends the session — the token dies server-side.
$("logout").onclick = async () => {
  $("logout").disabled = true;
  try {
    await api("POST", "/v1/logout", {});
  } catch (err) {
    fail(err);
  }
  location.replace("/");
};
