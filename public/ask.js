import { api, message } from "/api.js";
import { el, fmtDate, mount } from "/layout.js";

const $ = (id) => document.getElementById(id);
const summaryById = new Map();

await mount("/ask");

// Both are needed to word an answer: the Groups for the scope line, the
// Summaries so a cited summary id reads as a Group and a date.
Promise.all([api("GET", "/v1/groups"), api("GET", "/v1/summaries")])
  .then(([{ groups }, { summaries }]) => {
    for (const s of summaries) summaryById.set(s.id, s);
    const on = groups.filter((g) => g.enabled && !g.blocked);
    $("scope").replaceChildren(
      el("span", {
        text: on.length
          ? `Only the ${on.length} Group(s) you enabled are searched: ${on.map((g) => g.name ?? g.external_jid).join(", ")}. `
          : "No Group is enabled, so there is nothing to search. ",
      }),
      el("a", { href: "/groups", text: "Groups" }),
    );
  })
  .catch((err) => {
    $("scope").textContent = message(err);
  });

$("ask-form").onsubmit = async (e) => {
  e.preventDefault();
  $("error").hidden = true;
  $("go").disabled = true;
  try {
    render(await api("POST", "/v1/ask", { question: $("q").value.trim() }));
  } catch (err) {
    $("error").textContent = message(err);
    $("error").hidden = false;
  }
  $("go").disabled = false;
};

function render(answer) {
  $("answer").hidden = false;
  // §42: silence is an answer. Nothing retrieved supported a claim, so
  // the page says so rather than dressing up a guess.
  if (!answer.answered) {
    $("claims").replaceChildren(
      el("p", { text: "I don't know." }),
      el("p", {
        class: "muted",
        text: "Nothing in your enabled Groups answers that. Raw messages leave after your retention window, so older detail may only exist as a Summary.",
      }),
    );
    return;
  }
  // §41: a claim exists only with its sources — the API drops any claim
  // that cites nothing, so every line here is checkable.
  $("claims").replaceChildren(
    ...answer.claims.map((c) =>
      el(
        "div",
        { class: "source" },
        el("span", { text: c.text }),
        el(
          "div",
          { class: "chips" },
          ...c.source_ids.map((id) => el("span", { class: "chip", text: sourceLabel(id) })),
        ),
      ),
    ),
  );
}

function sourceLabel(id) {
  const s = summaryById.get(id);
  return s
    ? `Summary · ${s.group_name ?? s.chat_jid} · ${fmtDate(s.window_end)}`
    : `Message ${id.slice(0, 8)}`;
}
