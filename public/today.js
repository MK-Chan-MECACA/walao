import { api, message } from "/api.js";
import { citations, el, fmtDate, mount } from "/layout.js";

const $ = (id) => document.getElementById(id);
const SECTIONS = [
  ["action_items", "Action items"],
  ["open_questions", "Open questions"],
  ["decisions", "Decisions"],
  ["highlights", "Highlights"],
  ["dates", "Dates"],
  ["memory_candidates", "Memory candidates"],
];

// (summary, section, index) -> "complete" | "dismissed". The Brief merges an
// item across Groups, so one row can carry several of these keys; the row
// shows the state of its first source and writes to all of them.
const states = new Map();
const sourceKey = (s) => `${s.summary_id}|${s.section}|${s.item_index}`;

let summaries = [];
// Every item in the Brief, in bucket order — the meter counts against this.
let items = [];

const status = await mount("/today");
loadRail();

try {
  const [brief, history] = await Promise.all([
    api("GET", "/v1/briefs/today"),
    api("GET", "/v1/summaries"),
  ]);
  summaries = history.summaries;
  for (const s of summaries) {
    for (const st of s.states) {
      states.set(`${s.id}|${st.section}|${st.item_index}`, st.state);
    }
  }
  renderBrief(brief);
  renderFilters();
  renderHistory();
} catch (err) {
  fail(err);
}

function fail(err) {
  $("error").textContent = message(err);
  $("error").hidden = false;
}

function renderBrief(brief) {
  $("meta").textContent = `${brief.date} · drawn from ${brief.summary_count} Summary(ies) in the last 24 hours.`;
  if (status?.coverage_gap) {
    $("gap").textContent =
      `This Brief is partial: coverage stopped (${status.coverage_gap.reason}) at ` +
      `${fmtDate(status.coverage_gap.started_at)} and has not resumed.`;
    $("gap").hidden = false;
  }
  items = [];
  for (const bucket of ["needs_action", "decided", "worth_noting"]) {
    const bucketItems = brief[bucket];
    items.push(...bucketItems);
    $(bucket).hidden = bucketItems.length === 0;
    const h2 = $(bucket).querySelector("h2");
    h2.querySelector(".count")?.remove();
    h2.append(el("span", { class: "count", text: String(bucketItems.length) }));
    $(bucket).querySelector("ul").replaceChildren(...bucketItems.map(itemRow));
  }
  renderMeter();
  if (brief.summary_count === 0) emptyState();
}

// The Brief has an end and this is where you can see it: one tick per item,
// filled from the left as they are cleared. Ticks are a count, not a map —
// which particular items are done is what the rows themselves already say.
function renderMeter() {
  const meter = $("meter");
  meter.hidden = items.length === 0;
  if (meter.hidden) return;
  const cleared = items.filter((i) => states.get(sourceKey(i.sources[0]))).length;
  meter.querySelector(".ticks").replaceChildren(
    ...items.map((_, i) => el("span", { class: i < cleared ? "on" : null })),
  );
  meter.querySelector(".label").textContent = `${cleared} / ${items.length} cleared`;
}

// §44, §35: the rail. Read-only standing facts — each card ends at the screen
// that owns the thing, and a failure leaves its own card holding the reason
// rather than taking the Brief down with it.
async function loadRail() {
  fillCard("usage", api("GET", "/v1/usage"), (u) => [
    meterRow(u.usage.credits_today, u.limits.max_summaries_per_day, "Credits"),
    meterRow(u.usage.messages_today, u.limits.max_messages_per_day, "messages"),
    el("p", { class: "muted", text: "Resets 00:00 UTC" }),
  ]);
  fillCard("rail-groups", api("GET", "/v1/groups").then((d) => d.groups), (groups) => {
    const enabled = groups.filter((g) => g.enabled);
    const heading = el(
      "div",
      { class: "rail-head" },
      el("span", { class: "muted", text: `${enabled.length} of ${groups.length} enabled` }),
    );
    const list = el("ul", { class: "rail-groups" });
    if (enabled.length === 0) {
      list.append(el("li", { class: "muted", text: "No Group enabled yet." }));
    } else {
      for (const g of enabled) {
        const hasSchedule = !!g.schedule;
        list.append(
          el(
            "li",
            {},
            el("span", { class: hasSchedule ? "dot on" : "dot warn" }),
            el("span", { class: "grow", text: g.name ?? g.external_jid }),
            el("span", {
              class: "mono muted",
              text: hasSchedule ? g.schedule.local_time : "NO TIME",
            }),
          ),
        );
      }
    }
    return [heading, list, el("a", { href: "/groups", text: "Manage Groups →" })];
  });
  fillCard("open-reminders", api("GET", "/v1/reminders").then((d) => d.reminders), (list) => {
    const open = list.filter((r) => r.status === "open");
    const next = open
      .filter((r) => r.due_at)
      .sort((a, b) => a.due_at.localeCompare(b.due_at))[0];
    return [
      el(
        "div",
        { class: "metric" },
        el("strong", { text: String(open.length) }),
        el("span", { class: "muted", text: "confirmed by you" }),
      ),
      el("p", {
        class: "muted",
        text: next ? `Next: ${next.text} — ${fmtDate(next.due_at)}.` : "Nothing due.",
      }),
      el("a", { href: "/lists", text: "Lists →" }),
    ];
  });
}

async function fillCard(id, promise, render) {
  const card = $(id);
  const heading = card.querySelector("h3");
  let children;
  try {
    children = render(await promise);
  } catch (err) {
    children = [el("p", { class: "muted", text: message(err) })];
  }
  card.replaceChildren(heading, ...children);
}

function meterRow(used, limit, unit) {
  // The fill is set through the CSSOM, not a style attribute: `style-src
  // 'self'` (app.ts) blocks the attribute and would leave every bar empty.
  const fill = el("span");
  fill.style.width = `${Math.min(100, Math.round((used / limit) * 100))}%`;
  return el(
    "div",
    {},
    el(
      "div",
      { class: "metric" },
      el("strong", { text: used.toLocaleString() }),
      el("span", { class: "muted", text: `/ ${limit.toLocaleString()} ${unit}` }),
    ),
    el("div", { class: used >= limit ? "bar over" : "bar" }, fill),
  );
}

// §25: an empty Brief names what is missing, so the screen is a next step.
async function emptyState() {
  $("empty").hidden = false;
  const line = $("empty-line");
  const say = (text, href, label) =>
    line.replaceChildren(
      ...[el("span", { text }), href ? el("a", { href, text: label }) : null].filter(Boolean),
    );

  const reason = status?.block?.reason;
  if (reason === "unpaired") return say("No WhatsApp is connected yet. ", "/pair", "Pair");
  if (reason === "disconnected") return say("WhatsApp is disconnected. ", "/pair", "Re-pair");

  let groups = [];
  try {
    groups = (await api("GET", "/v1/groups")).groups;
  } catch (err) {
    return say(message(err));
  }
  const on = groups.filter((g) => g.enabled);
  if (groups.length === 0) {
    return say("WALAO can't see any Groups on this Session yet. ", "/pair", "Connection");
  }
  if (on.length === 0) {
    return say("No Group is enabled, so there is nothing to read. ", "/groups", "Enable one");
  }
  if (!on.some((g) => g.schedule)) {
    return say("No Group has a summary time set yet. ", "/groups", "Set one");
  }
  say("Nothing was summarized in the last 24 hours — your Groups were quiet.");
}

function itemRow(item) {
  const state = states.get(sourceKey(item.sources[0])) ?? null;
  const li = el("li", { class: state ? `item ${state}` : "item" });

  const groups = new Map();
  for (const s of item.sources) groups.set(s.group_id, s);
  const chips = el(
    "div",
    { class: "chips" },
    ...[...groups.values()].map((s) =>
      // §21: best-effort deep link. The inline sources below are the
      // reliable path; this is the one-tap bonus where the client honours
      // the whatsapp:// scheme.
      el("a", { class: "chip", href: s.jump_url, text: s.group_name ?? s.group_id }),
    ),
  );

  const mark = (next) =>
    el("button", {
      class: "secondary",
      text: next === "complete" ? "Done" : "Dismiss",
      "aria-pressed": state === next ? "true" : "false",
      onclick: () => setState(li, item, state === next ? null : next),
    });

  const actions = el("div", { class: "actions" });

  // §23: only an extracted action item can become a Reminder, and only by
  // this explicit confirmation. A merged item confirms from its first
  // Summary — the text is identical across them, so confirming each would
  // just make duplicate Reminders. It leads the row and it is the only one in
  // the accent: keeping a thing is the decision, clearing it is the default.
  const action = item.sources.find((s) => s.section === "action_items");
  if (action) {
    actions.append(
      el("button", {
        text: "Confirm as reminder",
        onclick: (e) => confirmReminder(e.target, action),
      }),
    );
  }
  actions.append(mark("complete"), mark("dismissed"));

  li.append(el("div", { class: "grow" }, el("p", { text: item.text }), chips), actions);
  // §20: the exact messages this item was drawn from, on demand.
  li.append(citations(item.sources));
  return li;
}

async function setState(li, item, next) {
  try {
    await Promise.all(
      item.sources.map((s) =>
        api(
          "PUT",
          `/v1/summaries/${s.summary_id}/items/${s.section}/${s.item_index}/state`,
          { state: next },
        ),
      ),
    );
  } catch (err) {
    return fail(err);
  }
  for (const s of item.sources) {
    if (next === null) states.delete(sourceKey(s));
    else states.set(sourceKey(s), next);
  }
  li.className = next ? `item ${next}` : "item";
  renderMeter();
  for (const b of li.querySelectorAll(".actions button")) {
    if (b.textContent === "Done") b.setAttribute("aria-pressed", next === "complete");
    if (b.textContent === "Dismiss") b.setAttribute("aria-pressed", next === "dismissed");
  }
}

async function confirmReminder(button, source) {
  button.disabled = true;
  try {
    await api(
      "POST",
      `/v1/summaries/${source.summary_id}/action-items/${source.item_index}/confirm`,
      {},
    );
    button.textContent = "Reminder created";
  } catch (err) {
    button.disabled = false;
    fail(err);
  }
}

// §26: past Summaries by date and Group, from the same list already
// fetched for item states — no second round trip.
function renderFilters() {
  const groups = new Map();
  for (const s of summaries) groups.set(s.group_id, s.group_name ?? s.chat_jid);
  for (const [id, name] of groups) {
    $("f-group").append(el("option", { value: id, text: name }));
  }
  $("f-date").onchange = renderHistory;
  $("f-group").onchange = renderHistory;
}

function renderHistory() {
  const date = $("f-date").value;
  const group = $("f-group").value;
  const shown = summaries.filter(
    (s) =>
      (!group || s.group_id === group) && (!date || s.window_end.slice(0, 10) === date),
  );
  $("history").replaceChildren(
    ...(shown.length
      ? shown.map(historyRow)
      : [el("li", { class: "muted", text: "No Summary matches that filter." })]),
  );
}

function historyRow(s) {
  const items = SECTIONS.flatMap(([key, label]) =>
    (s.payload[key] ?? []).map((it) =>
      el("p", { class: "source" }, el("span", { class: "muted", text: label }), el("span", { text: it.text })),
    ),
  );
  return el(
    "li",
    {},
    el(
      "div",
      { class: "grow" },
      el("strong", { text: s.group_name ?? s.chat_jid }),
      el("span", { class: "muted", text: ` ${fmtDate(s.window_end)} · ${s.language}` }),
    ),
    el("a", { class: "chip", href: s.jump_url, text: "Open in WhatsApp" }),
    el(
      "details",
      {},
      el("summary", { text: `${items.length} item(s)` }),
      el("div", { class: "sources" }, ...items),
    ),
  );
}
