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
          ? `Only the ${on.length} Group(s) you enabled are searched, over the last 90 days: ${on.map((g) => g.name ?? g.external_jid).join(", ")}. `
          : "No Group is enabled, so there is nothing to search. ",
      }),
      el("a", { href: "/groups", text: "Groups" }),
    );
  })
  .catch((err) => {
    $("scope").textContent = message(err);
  });

// The stages the server actually runs for one question, in order. The page
// cannot time them (the API answers once, at the end), so it walks them on a
// timer and stops on the last until the answer lands.
// ponytail: client-side pacing, not real progress; stream stages from the
// server if a run ever gets slow enough that a wrong-looking step misleads.
const STEPS = [
  "Reading the Groups you enabled",
  "Ranking Summaries and Memories against your question",
  "Claude drafts claims, each citing a source",
  "Dropping any claim whose citation is not real",
];

function startSteps() {
  const list = $("steps");
  list.hidden = false;
  list.replaceChildren(...STEPS.map((t) => el("li", { class: "pending", text: t })));
  let i = 0;
  const mark = () => {
    list.children[i].className = "running";
    if (i > 0) list.children[i - 1].className = "done";
  };
  mark();
  const timer = setInterval(() => {
    if (i >= STEPS.length - 1) return clearInterval(timer);
    i += 1;
    mark();
  }, 1200);
  return () => {
    clearInterval(timer);
    list.hidden = true;
  };
}

$("ask-form").onsubmit = async (e) => {
  e.preventDefault();
  $("error").hidden = true;
  $("answer").hidden = true;
  $("go").disabled = true;
  const stopSteps = startSteps();
  try {
    render(await api("POST", "/v1/ask", { question: $("q").value.trim() }));
  } catch (err) {
    $("error").textContent = message(err);
    $("error").hidden = false;
  }
  stopSteps();
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
