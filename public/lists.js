import { api, message } from "/api.js";
import { citations, el, fmtDate, mount } from "/layout.js";

const $ = (id) => document.getElementById(id);

await mount("/lists");
loadPlan();
load();

async function loadPlan() {
  try {
    const usage = await api("GET", "/v1/usage");
    const name = usage.plan.charAt(0).toUpperCase() + usage.plan.slice(1);
    $("plan-line").textContent = `${name} Plan. Reminders you confirmed. Memories you have saved.`;
  } catch {
    /* the status banner already reports a broken session */
  }
}

function fail(err) {
  $("error").textContent = message(err);
  $("error").hidden = false;
}

async function load() {
  $("error").hidden = true;
  // Three independent lists: one failing should not blank the other two.
  fill("reminders", api("GET", "/v1/reminders").then((d) => d.reminders), renderReminders);
  fill(
    "candidates",
    api("GET", "/v1/memories/candidates").then((d) => d.candidates),
    (list) => rows("candidates", list, candidateRow, "Nothing proposed right now."),
  );
  fill("memories", api("GET", "/v1/memories").then((d) => d.memories), (list) =>
    rows("memories", list, memoryRow, "No Memory confirmed yet."),
  );
}

async function fill(id, promise, render) {
  try {
    render(await promise);
  } catch (err) {
    $(id).replaceChildren(el("li", { class: "muted", text: message(err) }));
  }
}

function rows(id, list, row, empty) {
  $(id).replaceChildren(
    ...(list.length ? list.map(row) : [el("li", { class: "muted", text: empty })]),
  );
}

// §35: open Reminders are the list; the closed ones stay reachable behind a
// disclosure so the page is what is still owed.
function renderReminders(list) {
  const open = list.filter((r) => r.status === "open");
  const closed = list.filter((r) => r.status !== "open");
  rows("reminders", open, reminderRow, "Nothing confirmed as a reminder yet.");
  $("closed-box").hidden = closed.length === 0;
  $("closed").replaceChildren(...closed.map(reminderRow));
}

function reminderRow(r) {
  const due = r.due_at ? fmtDate(r.due_at) : "no due date";
  const meta = `${r.owner ?? "no owner"} · ${due}${r.status === "open" ? "" : ` · ${r.status}`}`;

  const actions = el("div", { class: "actions" });
  for (const [status, label] of r.status === "open"
    ? [
        ["done", "Done"],
        ["dismissed", "Dismiss"],
      ]
    : [["open", "Reopen"]]) {
    actions.append(
      el("button", {
        class: "secondary",
        text: label,
        onclick: (e) => save(e.target, r.id, { status }),
      }),
    );
  }

  return el(
    "li",
    { class: r.status === "open" ? null : "item dismissed" },
    el(
      "div",
      { class: "grow" },
      el("p", { text: r.text }),
      el("span", { class: "muted", text: meta }),
    ),
    actions,
    editForm(r),
    // §39: provenance survives the promotion — a Reminder keeps only its
    // Summary id, so its evidence is everything that Summary cites.
    r.summary_id ? citations([{ summary_id: r.summary_id }]) : null,
  );
}

// §36: owner and due date are the two fields a Reminder gets wrong.
function editForm(r) {
  const owner = el("input", { type: "text", value: r.owner ?? "", placeholder: "Nobody" });
  const due = el("input", { type: "datetime-local", value: toLocal(r.due_at) });
  const button = el("button", {
    text: "Save",
    onclick: () =>
      save(button, r.id, {
        owner: owner.value.trim() || null,
        due_at: due.value ? new Date(due.value).toISOString() : null,
      }),
  });
  return el(
    "details",
    {},
    el("summary", { text: "Edit" }),
    el("div", { class: "form" }, el("label", { text: "Owner" }), owner, el("label", { text: "Due" }), due, button),
  );
}

async function save(button, id, patch) {
  button.disabled = true;
  $("error").hidden = true;
  try {
    await api("PUT", `/v1/reminders/${id}`, patch);
  } catch (err) {
    fail(err);
  }
  button.disabled = false;
  fill("reminders", api("GET", "/v1/reminders").then((d) => d.reminders), renderReminders);
}

// <input type="datetime-local"> speaks local wall-clock; the API speaks
// ISO. Convert on both edges rather than storing a second representation.
function toLocal(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function candidateRow(c) {
  const confirm = el("button", {
    class: "secondary",
    text: "Keep this",
    onclick: async () => {
      confirm.disabled = true;
      $("error").hidden = true;
      try {
        await api(
          "POST",
          `/v1/summaries/${c.summary_id}/memory-candidates/${c.item_index}/confirm`,
          {},
        );
        load();
      } catch (err) {
        confirm.disabled = false;
        fail(err);
      }
    },
  });
  return el(
    "li",
    {},
    el(
      "div",
      { class: "grow" },
      el("p", { text: c.text }),
      el("span", {
        class: "muted",
        text: `${c.group_name ?? c.group_id} · lapses ${fmtDate(c.expires_at)}`,
      }),
    ),
    confirm,
    citations([c]),
  );
}

function memoryRow(m) {
  const content = el("textarea", { rows: 3 });
  content.value = m.content;
  const saveBtn = el("button", {
    text: "Save",
    onclick: () => write(saveBtn, "PUT", m.id, { content: content.value.trim() }),
  });
  const del = el("button", {
    class: "secondary",
    text: "Delete",
    onclick: () => write(del, "DELETE", m.id),
  });
  return el(
    "li",
    {},
    el(
      "div",
      { class: "grow" },
      el("p", { text: m.content }),
      el("span", {
        class: "muted",
        text: `kept ${fmtDate(m.created_at)}${m.last_used_at ? ` · last used ${fmtDate(m.last_used_at)}` : ""}`,
      }),
    ),
    el(
      "details",
      {},
      el("summary", { text: "Edit" }),
      el("div", { class: "form" }, content, el("div", { class: "actions" }, saveBtn, del)),
    ),
    // §39: the Summary this Memory was promoted from, and its messages.
    m.source.summary_id ? citations([m.source]) : null,
  );
}

async function write(button, method, id, body) {
  button.disabled = true;
  $("error").hidden = true;
  try {
    await api(method, `/v1/memories/${id}`, body);
    load();
  } catch (err) {
    button.disabled = false;
    fail(err);
  }
}
