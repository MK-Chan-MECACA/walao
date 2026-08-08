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
// Cached for console view — fetched once, rendered on toggle.
let cachedBrief = null;
let cachedGroups = [];
let cachedUsage = null;
let consoleBucket = "needs_action";

const status = await mount("/today");
loadRail();

try {
  const [brief, history] = await Promise.all([
    api("GET", "/v1/briefs/today"),
    api("GET", "/v1/summaries"),
  ]);
  summaries = history.summaries;
  cachedBrief = brief;
  for (const s of summaries) {
    for (const st of s.states) {
      states.set(`${s.id}|${st.section}|${st.item_index}`, st.state);
    }
  }
  renderPick(brief);
  renderFilters();
  renderHistory();
  // Pre-fetch console data
  loadConsoleData();
} catch (err) {
  fail(err);
}

async function loadConsoleData() {
  try {
    const [usage, groups] = await Promise.all([
      api("GET", "/v1/usage"),
      api("GET", "/v1/groups"),
    ]);
    cachedUsage = usage;
    cachedGroups = groups.groups;
    if (!$("console-view").hidden) renderConsole();
  } catch { /* rail cards handle their own errors */ }
}

// ═══════════════ Console view ═══════════════

$("to-console").onclick = () => {
  $("briefing-view").hidden = true;
  $("console-view").hidden = false;
  renderConsole();
};

$("to-briefing").onclick = () => {
  $("console-view").hidden = true;
  $("briefing-view").hidden = false;
};

$("console-tabs").onclick = (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  consoleBucket = btn.dataset.bucket;
  for (const b of $("console-tabs").querySelectorAll("button")) {
    b.className = b.dataset.bucket === consoleBucket ? "on" : "";
  }
  renderConsoleItems();
};

$("run-brief").onclick = async () => {
  $("run-brief").disabled = true;
  try {
    await api("POST", "/v1/briefs/run", {});
  } catch (err) {
    fail(err);
  }
  $("run-brief").disabled = false;
};

function renderConsole() {
  if (!cachedBrief) return;
  const brief = cachedBrief;

  // Date line
  $("console-date").textContent = `${new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })} · brief delivered ${brief.date}`;

  // Status chip
  $("console-status").textContent = status?.block
    ? `Blocked · ${status.block.reason}`
    : status?.session?.status
      ? `Processing · ${status.session.status}`
      : "Processing";

  // Counters
  const needsAction = brief.needs_action?.length ?? 0;
  const decided = brief.decided?.length ?? 0;
  const worthNoting = brief.worth_noting?.length ?? 0;
  $("counter-action").textContent = String(needsAction);
  $("counter-action-sub").textContent = needsAction ? `${needsAction} item(s)` : "Nothing needs action";
  $("counter-decided").textContent = String(decided);
  $("counter-decided-sub").textContent = `${decided + worthNoting} total across all buckets`;
  $("counter-summaries").textContent = String(brief.summary_count ?? 0);

  if (cachedUsage) {
    $("counter-summaries-sub").textContent = `${cachedUsage.usage.messages_today?.toLocaleString() ?? 0} messages read`;
    $("counter-credits").replaceChildren(
      document.createTextNode(String(cachedUsage.usage.credits_today ?? 0)),
      el("span", { class: "of", text: ` / ${cachedUsage.limits.max_summaries_per_day ?? 0}` }),
    );
    const pct = Math.min(100, Math.round(((cachedUsage.usage.credits_today ?? 0) / (cachedUsage.limits.max_summaries_per_day || 1)) * 100));
    $("counter-credits-bar").style.width = `${pct}%`;
  }

  // Coverage timeline
  renderCoverage();

  // Console groups
  renderConsoleGroups();

  // Console summaries
  renderConsoleSummaries();

  // Items
  renderConsoleItems();
}

function renderConsoleItems() {
  if (!cachedBrief) return;
  const bucketItems = cachedBrief[consoleBucket] ?? [];
  items = [];
  for (const b of ["needs_action", "decided", "worth_noting"]) {
    items.push(...(cachedBrief[b] ?? []));
  }
  const cleared = items.filter((i) => states.get(sourceKey(i.sources[0]))).length;
  $("console-meter").textContent = `${cleared} / ${items.length} CLEARED`;

  // Update segmented button labels with counts
  for (const b of $("console-tabs").querySelectorAll("button")) {
    const bk = b.dataset.bucket;
    const count = cachedBrief[bk]?.length ?? 0;
    b.textContent = `${b.dataset.bucket === "needs_action" ? "Needs action" : b.dataset.bucket === "decided" ? "Decided" : "Worth noting"} ${count}`;
  }

  if (bucketItems.length === 0) {
    $("console-items").replaceChildren(
      el("li", {}, el("p", { class: "muted", text: `Nothing in ${consoleBucket.replace("_", " ")} right now.` })),
    );
    return;
  }

  $("console-items").replaceChildren(
    ...bucketItems.map((item, i) => consoleItemRow(item, i)),
  );
}

function consoleItemRow(item, index) {
  const state = states.get(sourceKey(item.sources[0])) ?? null;

  const groups = new Map();
  for (const s of item.sources) groups.set(s.group_id, s);

  const chips = el(
    "div",
    { class: "chips" },
    ...[...groups.values()].map((s) =>
      el("span", { class: "chip", text: s.group_name ?? s.group_id }),
    ),
  );

  const action = item.sources.find((s) => s.section === "action_items");

  const actions = el("div", { class: "item-actions" });
  if (action) {
    actions.append(
      el("button", {
        text: "Confirm as reminder",
        onclick: (e) => confirmReminder(e.target, action),
      }),
    );
  }
  actions.append(
    el("button", {
      class: "secondary",
      text: "Done",
      "aria-pressed": state === "complete" ? "true" : "false",
      onclick: (e) => setConsoleState(e.target, item, state === "complete" ? null : "complete"),
    }),
    el("button", {
      class: "secondary",
      text: "Dismiss",
      "aria-pressed": state === "dismissed" ? "true" : "false",
      onclick: (e) => setConsoleState(e.target, item, state === "dismissed" ? null : "dismissed"),
    }),
  );

  const body = el("div", { class: "item-body" },
    el("p", { text: item.text }),
    chips,
    actions,
    citations(item.sources),
  );

  return el("li", {},
    el("span", { class: "item-num", text: String(index + 1).padStart(2, "0") }),
    body,
  );
}

async function setConsoleState(button, item, next) {
  button.disabled = true;
  try {
    await Promise.all(
      item.sources.map((s) =>
        api("PUT", `/v1/summaries/${s.summary_id}/items/${s.section}/${s.item_index}/state`, { state: next }),
      ),
    );
  } catch (err) {
    button.disabled = false;
    return fail(err);
  }
  for (const s of item.sources) {
    if (next === null) states.delete(sourceKey(s));
    else states.set(sourceKey(s), next);
  }
  renderConsoleItems();
}

function renderCoverage() {
  const gap = status?.coverage_gap;
  if (!gap) {
    $("coverage-card").hidden = true;
    return;
  }
  $("coverage-card").hidden = false;

  const now = Date.now();
  const gapStart = new Date(gap.started_at).getTime();
  const gapEnd = gap.resumed_at ? new Date(gap.resumed_at).getTime() : now;
  const dayStart = now - 24 * 60 * 60 * 1000;

  // Normalize to 24h window
  const total = now - dayStart;
  const beforeGap = Math.max(0, gapStart - dayStart);
  const gapDuration = gapEnd - gapStart;
  const afterGap = Math.max(0, now - gapEnd);

  const beforePct = Math.round((beforeGap / total) * 100);
  const gapPct = Math.round((gapDuration / total) * 100);
  const afterPct = 100 - beforePct - gapPct;

  $("coverage-gap-label").textContent = `${Math.round(gapDuration / 3600000)}h ${Math.round((gapDuration % 3600000) / 60000)}m gap`;
  // Widths go through the CSSOM, not a style attribute: `style-src 'self'`
  // blocks the attribute and would leave the bar as three equal thirds.
  const seg = (cls, pct) => {
    const s = el("span", { class: cls });
    s.style.flex = `${pct} 1 0`;
    return s;
  };
  $("coverage-bar").replaceChildren(
    seg("on", beforePct),
    seg("gap", gapPct),
    seg("on", afterPct),
  );

  const fmt = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  $("coverage-labels").replaceChildren(
    el("span", { text: fmt(dayStart) }),
    el("span", { text: fmt(gapStart) }),
    el("span", { text: fmt(gapEnd) }),
    el("span", { text: "NOW" }),
  );

  $("coverage-note").replaceChildren(
    document.createTextNode(`Disconnected ${fmt(gapStart)}–${fmt(gapEnd)}, so this Brief is partial. `),
    el("a", { href: "/pair", text: "Re-pair" }),
  );
}

function renderConsoleGroups() {
  const enabled = cachedGroups.filter((g) => g.enabled);
  $("console-groups-count").textContent = `${enabled.length} of ${cachedGroups.length} enabled`;

  const list = $("console-groups-list");
  if (enabled.length === 0) {
    list.replaceChildren(el("li", { class: "muted", text: "No Group enabled yet." }));
    return;
  }

  list.replaceChildren(
    ...enabled.map((g) => {
      const hasSchedule = !!g.schedule;
      return el("li", {},
        el("span", { class: hasSchedule ? "dot on" : "dot warn" }),
        el("span", { class: "grow", text: g.name ?? g.external_jid }),
        el("span", {
          class: "mono muted",
          text: hasSchedule ? g.schedule.local_time : "NO TIME",
        }),
      );
    }),
  );
}

function renderConsoleSummaries() {
  const latest = summaries.slice(0, 3);
  const list = $("console-summaries-list");
  if (latest.length === 0) {
    list.replaceChildren(el("li", { class: "muted", text: "No Summaries yet." }));
    return;
  }

  list.replaceChildren(
    ...latest.map((s) =>
      el("li", {},
        el("div", { class: "grow" },
          el("strong", { text: s.group_name ?? s.chat_jid }),
          el("span", {
            class: "mono muted",
            text: ` ${fmtDate(s.window_end).toUpperCase()} · ${s.language?.toUpperCase() ?? "EN"} · ${(s.payload?.action_items?.length ?? 0) + (s.payload?.decisions?.length ?? 0) + (s.payload?.highlights?.length ?? 0)} ITEMS`,
          }),
        ),
      ),
    ),
  );
}

function fail(err) {
  $("error").textContent = message(err);
  $("error").hidden = false;
}

// The calm view: the day's headline and at most the picked items. Everything
// else is one click away in the Console — which is also the only way to correct
// a pick, so the link says how much it is hiding.
function renderPick(brief) {
  $("meta").textContent = `${brief.date} · drawn from ${brief.summary_count} Summary(ies) in the last 24 hours.`;
  if (status?.coverage_gap) {
    $("gap").textContent =
      `This Brief is partial: coverage stopped (${status.coverage_gap.reason}) at ` +
      `${fmtDate(status.coverage_gap.started_at)} and has not resumed.`;
    $("gap").hidden = false;
  }
  items = [];
  for (const bucket of ["needs_action", "decided", "worth_noting"]) {
    items.push(...brief[bucket]);
  }

  if (brief.summary_count === 0) {
    emptyState();
    return;
  }

  const byKey = new Map(items.map((i) => [sourceKey(i.sources[0]), i]));
  const picked = (brief.pick?.keys ?? []).map((k) => byKey.get(k)).filter(Boolean);

  $("pick").hidden = false;
  $("headline").textContent = picked.length
    ? (brief.pick?.headline || "Here's today.")
    : "Nothing needs you today.";
  $("pick-items").replaceChildren(...picked.map(pickRow));

  const rest = items.length - picked.length;
  $("to-console").textContent = rest > 0 ? `${rest} more · Console →` : "Console →";
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

// A picked row does only what does something in the world: name its Group and
// keep the thing as a Reminder. Done and Dismiss live in the Console — on a
// two-item page they are bookkeeping.
function pickRow(item) {
  const groups = new Map();
  for (const s of item.sources) groups.set(s.group_id, s);
  const chips = el(
    "div",
    { class: "chips" },
    // §21: the inline sources below are the reliable path back to the Group.
    ...[...groups.values()].map((s) =>
      el("span", { class: "chip", text: s.group_name ?? s.group_id }),
    ),
  );

  const actions = el("div", { class: "actions" });
  // §23: only an extracted action item can become a Reminder, and only by
  // this explicit confirmation. A merged item confirms from its first
  // Summary — the text is identical across them, so confirming each would
  // just make duplicate Reminders.
  const action = item.sources.find((s) => s.section === "action_items");
  if (action) {
    actions.append(
      el("button", {
        text: "Confirm as reminder",
        onclick: (e) => confirmReminder(e.target, action),
      }),
    );
  }

  return el("li", {},
    el("div", { class: "grow" }, el("p", { text: item.text }), chips),
    actions,
    // §20: the exact messages this item was drawn from, on demand.
    citations(item.sources),
  );
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
    el(
      "details",
      {},
      el("summary", { text: `${items.length} item(s)` }),
      el("div", { class: "sources" }, ...items),
    ),
  );
}
