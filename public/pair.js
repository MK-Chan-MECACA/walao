import { api, message } from "/api.js";
import { el, fmtDate, mount } from "/layout.js";

const $ = (id) => document.getElementById(id);
let disclosure = null;
let poll = null;

await mount("/pair");
loadConnections();

api("GET", "/v1/onboarding")
  .then((d) => {
    disclosure = d;
    $("disclosure-text").textContent = d.text;
    $("disclosure-version").textContent = `· version ${d.version}`;
  })
  .catch((err) => {
    $("disclosure-text").textContent = message(err);
  });

$("disclosure-ok").onchange = (e) => {
  $("pair").disabled = !e.target.checked;
};

$("pair").onclick = async () => {
  $("error").hidden = true;
  $("pair").disabled = true;
  try {
    const res = await api("POST", "/v1/connections", {
      disclosure_version: disclosure?.version,
    });
    const qr = qrcode(0, "M");
    qr.addData(res.pairing_code);
    qr.make();
    $("qr-code").replaceChildren(
      el("img", { src: qr.createDataURL(6), alt: "WhatsApp pairing QR code" }),
    );
    $("code-box").hidden = false;
    // §14: the status arrives without a reload. Cheap poll — the gateway
    // reports connection state on its own webhook, not to this tab.
    poll = setInterval(loadConnections, 3000);
    loadConnections();
  } catch (err) {
    $("error").textContent = message(err);
    $("error").hidden = false;
    $("pair").disabled = false;
  }
};

async function loadConnections() {
  let data;
  try {
    data = await api("GET", "/v1/connections");
  } catch (err) {
    $("connections").replaceChildren(el("li", { class: "muted", text: message(err) }));
    return;
  }

  const live = data.connections.find((c) => c.status === "connected");

  // Dashboard, 2a — live banner: one compact row confirming the active session.
  if (live) {
    $("live-banner").hidden = false;
    $("live-since").textContent = `SINCE ${fmtDate(live.status_changed_at).toUpperCase()}`;
  } else {
    $("live-banner").hidden = true;
  }

  // Dashboard, 2a — Sessions: each row in its own card-like surface, status
  // dot + bold label (green for connected) + mono session id and timestamps.
  const rows = data.connections.map((c) => {
    const active = c.status === "connected";
    const resumed = c.resumed_at ? ` · resumed ${fmtDate(c.resumed_at)}` : "";
    return el(
      "li",
      { class: active ? null : "past" },
      el(
        "div",
        { class: "grow" },
        el("div", { class: "row-head" },
          el("span", { class: active ? "dot on" : "dot off" }),
          el("strong", { class: active ? "accent" : null, text: c.status }),
        ),
        el("span", {
          class: "mono muted",
          text: `since ${fmtDate(c.status_changed_at)} · ${c.external_session_id}${resumed}`,
        }),
      ),
      active
        ? el("button", {
            class: "secondary",
            text: "Disconnect",
            onclick: () => disconnect(c.id),
          })
        : null,
    );
  });
  $("connections").replaceChildren(
    ...(rows.length ? rows : [el("li", { class: "muted", text: "No connection yet." })]),
  );

  // Mid-pairing: the QR code is showing, keep polling. Connected: stop polling
  // and update chrome (the status banner changes with it).
  if (live && poll) {
    clearInterval(poll);
    poll = null;
    $("code-box").hidden = true;
    await mount("/pair");
  }

  // Pairing section: always visible. The disclosure+button exist for pairing
  // another number (or the first one). Reset button state after disconnect.
  if (!live && poll === null) {
    $("pair").disabled = !$("disclosure-ok").checked;
    $("code-box").hidden = true;
  }
}

async function disconnect(id) {
  try {
    await api("POST", `/v1/connections/${id}/disconnect`);
    await loadConnections();
    await mount("/pair");
  } catch (err) {
    $("error").textContent = message(err);
    $("error").hidden = false;
  }
}
