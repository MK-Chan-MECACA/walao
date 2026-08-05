import { api, message } from "/api.js";
import { el, fmtDate, mount } from "/layout.js";

const $ = (id) => document.getElementById(id);
const error = $("error");
let disclosure = null;
let poll = null;

await mount("/pair");
loadTrial();
loadConnections();

api("GET", "/v1/onboarding")
  .then((d) => {
    disclosure = d;
    $("disclosure-text").textContent = d.text;
    $("disclosure-version").textContent = `version ${d.version}`;
  })
  .catch((err) => {
    $("disclosure-text").textContent = message(err);
  });

$("disclosure-ok").onchange = (e) => {
  $("pair").disabled = !e.target.checked;
};

$("pair").onclick = async () => {
  error.hidden = true;
  $("pair").disabled = true;
  try {
    const res = await api("POST", "/v1/connections", {
      disclosure_version: disclosure?.version,
    });
    const qr = qrcode(0, "M");
    qr.addData(res.pairing_code);
    qr.make();
    // F10: built as a node, not parsed from a string — the innerHTML sink does
    // not exist anywhere in public/ and this was the last one.
    $("qr-code").replaceChildren(
      el("img", { src: qr.createDataURL(6), alt: "WhatsApp pairing QR code" }),
    );
    $("code-box").hidden = false;
    $("pair-box").hidden = true;
    // §14: the status arrives without a reload. Cheap poll — the gateway
    // reports connection state on its own webhook, not to this tab.
    poll = setInterval(loadConnections, 3000);
    loadConnections();
  } catch (err) {
    error.textContent = message(err);
    error.hidden = false;
    $("pair").disabled = false;
  }
};

async function loadTrial() {
  try {
    const usage = await api("GET", "/v1/usage");
    $("trial").textContent = usage.trial
      ? `Trial: ${usage.trial.days_remaining} day(s) left, ends ${fmtDate(usage.trial.ends_at)}.`
      : `Plan: ${usage.plan}.`;
  } catch {
    /* the status banner already reports a broken session */
  }
}

async function loadConnections() {
  let data;
  try {
    data = await api("GET", "/v1/connections");
  } catch (err) {
    $("connections").replaceChildren(el("li", { class: "muted", text: message(err) }));
    return;
  }

  const rows = data.connections.map((c) =>
    el(
      "li",
      {},
      el(
        "span",
        {},
        el("strong", { text: c.status }),
        el("span", {
          class: "muted",
          text: ` since ${fmtDate(c.status_changed_at)} · ${c.external_session_id}`,
        }),
      ),
      c.status === "disconnected"
        ? null
        : el("button", {
            class: "secondary",
            text: "Disconnect",
            onclick: () => disconnect(c.id),
          }),
    ),
  );
  $("connections").replaceChildren(
    ...(rows.length ? rows : [el("li", { class: "muted", text: "No connection yet." })]),
  );

  // Connected: nothing to pair, so the disclosure and the code give way to
  // the history. Disconnecting brings the pairing box back.
  const live = data.connections.some((c) => c.status === "connected");
  $("pair-box").hidden = live || poll !== null; // mid-pairing: the code stands alone
  $("qr-code").hidden = live;
  if (!live && poll === null) $("pair").disabled = !$("disclosure-ok").checked;
  if (live && poll) {
    clearInterval(poll);
    poll = null;
    $("waiting").textContent = "Connected. WALAO is reading the Groups you enable.";
    await mount("/pair");
    loadTrial();
  }
}

async function disconnect(id) {
  try {
    await api("POST", `/v1/connections/${id}/disconnect`);
    await loadConnections();
    await mount("/pair");
  } catch (err) {
    error.textContent = message(err);
    error.hidden = false;
  }
}
