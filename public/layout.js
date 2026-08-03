// Shared chrome: the nav and the one status line every authenticated page shows
// (app spec §6). Block wording lives here and nowhere else — a page that invents
// its own copy for a block is the bug this module exists to prevent.

import { api, message } from "/api.js";

const NAV = [
  ["/today", "Today"],
  ["/groups", "Groups"],
  ["/lists", "Lists"],
  ["/ask", "Ask"],
  ["/pair", "Connection"],
  ["/settings", "Settings"],
];

// reason -> [line, [href, action label] | null]
const BLOCK = {
  halted: ["WALAO is paused product-wide.", null],
  unpaid: ["There's a billing problem on this Account. Contact support.", null],
  paused: ["You paused processing.", ["/settings", "Resume"]],
  unpaired: ["No WhatsApp connected yet.", ["/pair", "Pair"]],
  disconnected: ["WhatsApp disconnected.", ["/pair", "Re-pair"]],
  over_group_cap: ["More Groups enabled than your Plan allows.", ["/groups", "Manage Groups"]],
  over_daily_messages: ["Daily limit reached; resets at midnight UTC.", ["/settings", "Upgrade"]],
  over_daily_credits: ["Daily limit reached; resets at midnight UTC.", ["/settings", "Upgrade"]],
};

// textContent-only element builder: every string the app renders comes from the
// API or a Group, so nothing reaches innerHTML.
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "text") node.textContent = v;
    else if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) if (c) node.append(c);
  return node;
}

export function fmtDate(iso) {
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// Renders nav + banner into <header id="chrome"> and returns the status, so a
// page that needs the block reason does not fetch /v1/status twice.
export async function mount(active) {
  const chrome = document.getElementById("chrome");
  const nav = el("nav");
  for (const [href, label] of NAV) {
    nav.append(el("a", { href, text: label, "aria-current": href === active ? "page" : null }));
  }
  const banner = el("div", { class: "status" });
  chrome.replaceChildren(nav, banner);
  return refresh(banner);
}

async function refresh(banner) {
  let status;
  try {
    status = await api("GET", "/v1/status");
  } catch (err) {
    banner.className = "status blocked";
    banner.replaceChildren(el("span", { class: "dot" }), el("span", { text: message(err) }));
    return null;
  }

  const parts = [el("span", { class: "dot" })];
  if (status.block) {
    const [line, action] = BLOCK[status.block.reason] ?? [
      `Processing is blocked (${status.block.reason}).`,
      null,
    ];
    parts.push(el("span", { text: line }));
    if (action) parts.push(el("a", { href: action[0], text: action[1] }));
  } else {
    parts.push(el("span", { text: "WALAO is processing." }));
  }
  if (status.session) {
    parts.push(el("span", { class: "muted", text: `Session: ${status.session.status}` }));
  }
  if (status.coverage_gap) {
    parts.push(
      el("span", {
        class: "muted",
        text: `Coverage gap since ${fmtDate(status.coverage_gap.started_at)} (${status.coverage_gap.reason}) — this Brief is partial.`,
      }),
    );
  }
  banner.className = status.block ? "status blocked" : "status";
  banner.replaceChildren(...parts);
  return status;
}
