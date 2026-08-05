import { api, message } from "/api.js";
import { el, mount } from "/layout.js";

const $ = (id) => document.getElementById(id);
const LANGUAGES = [
  ["en", "English"],
  ["zh", "中文"],
  ["ms", "Bahasa Melayu"],
];
const HERE = Intl.DateTimeFormat().resolvedOptions().timeZone;

let attestation = null;
let groups = []; // every Group this Session can see, sorted once at load

// backfillGroupNames stamps a JID into `name` when WhatsApp stops
// returning the Group, so an unnamed row can arrive either way.
const shown = (g) => g.name ?? g.external_jid;
const nameless = (g) => shown(g).endsWith("@g.us");

await mount("/groups");
load();

// §28 still holds: enabling records its own Attestation, and a bumped
// version comes back unticked. What is restored is only that this Account
// already affirmed *this* wording — the box is a standing affirmation
// ("for every Group I enable"), so re-reading its own consent trail is
// what makes it survive a reload instead of leaving every Enable inert.
Promise.all([api("GET", "/v1/attestation-texts"), api("GET", "/v1/attestations")])
  .then(([texts, { attestations }]) => {
    attestation = texts.group_responsibility;
    $("attestation-text").textContent = attestation.text;
    $("attestation-version").textContent = `version ${attestation.version}`;
    if (
      attestations.some(
        (a) => a.kind === "group_responsibility" && a.version === attestation.version,
      )
    ) {
      $("attestation-ok").checked = true;
      syncEnables(); // load() may have already rendered its rows unticked
    }
  })
  .catch((err) => {
    $("attestation-text").textContent = message(err);
  });

api("GET", "/v1/disclosure-template")
  .then((d) => {
    $("disclosure").value = d.text;
  })
  .catch((err) => {
    $("disclosure").value = message(err);
  });

$("copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("disclosure").value);
    $("copy").textContent = "Copied";
  } catch {
    // Clipboard access denied (or an insecure origin): selecting the text
    // is the fallback that always works.
    $("disclosure").select();
    $("copy").textContent = "Press ⌘/Ctrl+C";
  }
};

function syncEnables() {
  const ok = $("attestation-ok").checked;
  for (const b of document.querySelectorAll("button.enable")) b.disabled = !ok;
}
$("attestation-ok").onchange = syncEnables;

function fail(err) {
  $("error").textContent = message(err);
  $("error").hidden = false;
  // A refusal at the cap is worth nothing if it renders off-screen above a
  // list the merchant has scrolled a long way down.
  $("error").scrollIntoView({ block: "nearest" });
}

// Every mutating path re-renders through here, so preserving the scroll
// position is done once, here, rather than in each caller — enabling a
// Group must not cost you your place in a list of hundreds.
async function load() {
  const y = window.scrollY;
  $("error").hidden = true;
  let list, usage;
  try {
    [{ groups: list }, usage] = await Promise.all([
      api("GET", "/v1/groups"),
      api("GET", "/v1/usage"),
    ]);
  } catch (err) {
    $("groups").replaceChildren(el("li", { class: "muted", text: message(err) }));
    return;
  }

  const cap = usage.limits.max_groups;
  const on = usage.usage.enabled_groups;
  $("cap").textContent = `Plan ${usage.plan} · ${on} of ${cap} Group(s) enabled.`;
  // §33: the cap is stated where the merchant would act on it.
  $("over-cap").textContent =
    `You have more Groups enabled than your Plan allows. The ones marked blocked below ` +
    `are not being read — disable one, or upgrade your Plan.`;
  $("over-cap").hidden = on <= cap;

  // A→Z, with the ones still carrying a JID for a name last. Deliberately
  // not enabled-first: a Group that jumps the moment you toggle it is the
  // same lost-your-place problem in a different coat.
  groups = list.sort(
    (a, b) =>
      nameless(a) - nameless(b) ||
      shown(a).localeCompare(shown(b), undefined, { sensitivity: "base" }),
  );
  render();
  window.scrollTo(0, y);
}

// The filter controls live outside the <ul>, so their state survives every
// re-render for free — including the one that follows enabling a Group.
function render() {
  const q = $("f-q").value.trim().toLowerCase();
  const state = $("f-state").value;
  const matches = groups.filter(
    (g) =>
      (!q || `${g.name ?? ""} ${g.external_jid}`.toLowerCase().includes(q)) &&
      (!state || g.enabled === (state === "on")),
  );

  $("count").textContent = groups.length
    ? `Showing ${matches.length} of ${groups.length} Group(s).`
    : "";
  $("groups").replaceChildren(
    ...(matches.length
      ? matches.map(row)
      : [
          el("li", {
            class: "muted",
            text: groups.length
              ? "No Group matches that filter."
              : "No Group is visible on this Session yet.",
          }),
        ]),
  );
}
$("f-q").oninput = render;
$("f-state").onchange = render;

function row(g) {
  const name = shown(g);
  const state = g.blocked ? "blocked" : g.enabled ? "enabled" : "off";
  const label = {
    blocked: "blocked — over your Plan's Group cap, not being read",
    enabled: g.schedule
      ? `enabled · ${g.schedule.local_time} ${g.schedule.timezone} · ${g.schedule.language}`
      : "enabled · no summary time set yet",
    off: "not enabled — WALAO is not reading it",
  }[state];

  const toggle = el("button", {
    class: g.enabled ? "secondary" : "secondary enable",
    text: g.enabled ? "Disable" : "Enable",
    disabled: !g.enabled && !$("attestation-ok").checked,
    onclick: () => setEnabled(g, !g.enabled),
  });

  return el(
    "li",
    { class: state },
    el(
      "div",
      { class: "grow" },
      el("strong", { text: name }),
      el("span", { class: "muted", text: ` ${label}` }),
    ),
    toggle,
    g.enabled ? scheduleForm(g) : null,
    dataDeletion(g, name),
  );
}

async function setEnabled(g, on) {
  $("error").hidden = true;
  try {
    if (on) {
      await api("POST", `/v1/groups/${g.id}/enable`, {
        attestation_version: attestation?.version,
      });
    } else {
      await api("POST", `/v1/groups/${g.id}/disable`);
    }
  } catch (err) {
    // §34: a refusal at the cap is not a dead end — api.js words it with
    // the options, and the cap line above stays on screen.
    fail(err);
  }
  await mount("/groups"); // enabling can clear or raise a block
  load();
}

// §31: when and in what language the Brief arrives. Only an enabled Group
// can carry a schedule, which is why this form only exists on one.
function scheduleForm(g) {
  const time = el("input", { type: "time", value: g.schedule?.local_time ?? "18:00" });
  const zone = el("input", { type: "text", value: g.schedule?.timezone ?? HERE });
  const lang = el(
    "select",
    {},
    ...LANGUAGES.map(([v, text]) =>
      el("option", { value: v, text, selected: (g.schedule?.language ?? "en") === v }),
    ),
  );
  const save = el("button", {
    text: "Save schedule",
    onclick: async () => {
      save.disabled = true;
      try {
        await api("PUT", `/v1/groups/${g.id}/schedule`, {
          local_time: time.value,
          timezone: zone.value,
          language: lang.value,
        });
        load();
      } catch (err) {
        save.disabled = false;
        fail(err);
      }
    },
  });
  return el(
    "details",
    {},
    el("summary", { text: "Summary time" }),
    el(
      "div",
      { class: "form" },
      el("label", { text: "Time" }),
      time,
      el("label", { text: "Timezone" }),
      zone,
      el("label", { text: "Language" }),
      lang,
      save,
    ),
  );
}

// §32: forgetting what was read is a separate choice from stopping the
// reading. Behind a disclosure so it is never one stray tap.
function dataDeletion(g, name) {
  const go = el("button", {
    class: "secondary",
    text: "Delete stored data",
    onclick: async () => {
      go.disabled = true;
      try {
        await api("DELETE", `/v1/groups/${g.id}`);
        load();
      } catch (err) {
        go.disabled = false;
        fail(err);
      }
    },
  });
  return el(
    "details",
    {},
    el("summary", { text: "Delete data" }),
    el(
      "div",
      { class: "form" },
      el("p", {
        class: "muted",
        text: `Deletes every stored message and Summary WALAO holds for ${name}. This cannot be undone. It does not disable the Group.`,
      }),
      go,
    ),
  );
}
