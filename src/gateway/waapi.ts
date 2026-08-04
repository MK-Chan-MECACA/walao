import type { GatewayEvent, GatewayPort, NormalizedEvent, SessionStatus } from "./port.ts";
import { hashToken } from "../crypto.ts";

// WAAPI Gateway adapter (github.com/mecaca-global-inc/waapi-gateway).
// This is the ONLY module that knows the gateway's wire shape.
// Verified against a live gateway on 2026-07-31.
//
// Message event:
//   { "event":"message", "session":"<name>", "timestamp":<unix s>,
//     "payload": { "id","chat","sender","addressing_mode","from_me",
//                  "timestamp","push_name","body","has_media","sender_alt"? } }
//
// Status events: "session.status" {status}, "state.pair" {jid},
//   "state.qr" {code}, "state.loggedout" {reason,on_connect}.
//
// Note the gateway carries no chat NAME on message events (only push_name, the
// sender's display name), so groupName is always null here — group titles come
// from GET /api/{session}/groups, not the webhook.

function asRecord(v: unknown): Record<string, unknown> {
  if (typeof v !== "object" || v === null) throw new Error("payload is not an object");
  return v as Record<string, unknown>;
}

function str(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) throw new Error(`missing/invalid ${field}`);
  return v;
}

// Gateway session states -> WALAO's three. STARTING is the reconnect path, so
// it counts as disconnected: coverage_gaps opens for the blip and closes when
// WORKING returns, which is exactly the "incomplete window" the spec wants.
// SCAN_QR / logged-out need the user to act, so they are re_pair_required.
const STATUS_MAP: Record<string, SessionStatus> = {
  WORKING: "connected",
  STARTING: "disconnected",
  STOPPED: "disconnected",
  FAILED: "disconnected",
  SCAN_QR: "re_pair_required",
};

// Strip WhatsApp's device/agent suffix: "60123456789:13@s.whatsapp.net" is one
// linked device, not the chat. Sending to it targets a single device.
function toChatId(jid: string): string {
  const [user] = jid.split("@");
  return (user ?? "").split(":")[0] ?? "";
}

export class WaapiGateway implements GatewayPort {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly webhookUrl: string;
  readonly webhookSecret: string;

  constructor(baseUrl: string, apiKey: string, webhookUrl: string, webhookSecret: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.webhookUrl = webhookUrl;
    this.webhookSecret = webhookSecret;
  }

  parse(payload: unknown): GatewayEvent {
    const root = asRecord(payload);
    const event = root.event;
    const sessionExternalId = str(root.session, "session");

    if (event === "message") {
      const msg = asRecord(root.payload);
      // Gateway timestamps are unix seconds.
      const ts = msg.timestamp;
      if (typeof ts !== "number" || !Number.isFinite(ts)) {
        throw new Error("missing/invalid timestamp");
      }
      const normalized: NormalizedEvent = {
        type: "message",
        sessionExternalId,
        groupJid: str(msg.chat, "chat"),
        groupName: null,
        externalMessageId: str(msg.id, "id"),
        senderRef: typeof msg.sender === "string" ? msg.sender : null,
        text: typeof msg.body === "string" ? msg.body : "",
        sentAt: new Date(ts * 1000),
        fromMe: msg.from_me === true,
      };
      return normalized;
    }

    if (event === "session.status") {
      const status = STATUS_MAP[str(asRecord(root.payload).status, "status")];
      if (!status) throw new Error("unsupported session status");
      return { type: "status", sessionExternalId, status };
    }

    // state.pair rides alongside session.status WORKING and state.qr alongside
    // SCAN_QR; both are handled so a dropped session.status still converges.
    if (event === "state.pair") return { type: "status", sessionExternalId, status: "connected" };
    if (event === "state.qr" || event === "state.loggedout") {
      return { type: "status", sessionExternalId, status: "re_pair_required" };
    }

    throw new Error(`unsupported event: ${String(event)}`);
  }

  // Errors are Fiber defaults — plain text, not JSON — so the body is read as
  // text and never JSON.parsed.
  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    if (!this.apiKey) throw new Error("WAAPI_API_KEY not configured");
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "x-api-key": this.apiKey,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`waapi ${method} ${path} -> ${res.status} ${(await res.text()).trim()}`);
    }
    return res.status === 204 ? null : await res.json();
  }

  // Create + start a session, then wait for the QR string. The gateway has no
  // push for this on the REST side, so it is polled — the same thing its own
  // dashboard does.
  // ponytail: fixed 30s ceiling; the gateway's /ws stream would push instead if
  // pairing latency ever matters.
  async startPairing(): Promise<{ externalSessionId: string; pairingCode: string }> {
    const name = `walao-${crypto.randomUUID().slice(0, 8)}`;
    await this.call("POST", "/api/sessions", { name });
    await this.call("POST", `/api/sessions/${name}/start`, {});

    // Register the webhook so the gateway delivers status and message events back
    // to WALAO. Without this the session pairs but WALAO never learns about it.
    // Events: message (ingest), session.status + state.pair + state.qr +
    // state.loggedout (connection lifecycle). The call is fire-and-forget — a
    // missed webhook registration is self-correcting on the next startPairing.
    await this.registerWebhook(name);

    for (let i = 0; i < 30; i++) {
      const qr = asRecord(await this.call("GET", `/api/${name}/auth/qr`));
      if (typeof qr.code === "string" && qr.code.length > 0) {
        return { externalSessionId: name, pairingCode: qr.code };
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("waapi pairing: no QR after 30s");
  }

  private async registerWebhook(sessionName: string): Promise<void> {
    try {
      await this.call("POST", `/api/sessions/${sessionName}/webhooks`, {
        url: this.webhookUrl,
        secret: this.webhookSecret,
        events: ["message", "session.status", "state.pair", "state.qr", "state.loggedout"],
      });
    } catch (err) {
      // Webhook registration is best-effort. If it fails the session still pairs
      // — status just won't flow until the next pairing or manual registration.
      console.error(`waapi webhook registration failed for ${sessionName}:`, err);
    }
  }

  async sendToSelf(externalSessionId: string, text: string): Promise<void> {
    const me = asRecord(await this.call("GET", `/api/${externalSessionId}/me`));
    await this.sendText(externalSessionId, toChatId(str(me.jid, "jid")), text);
  }

  async sendToRecipient(
    externalSessionId: string,
    recipientJid: string,
    text: string,
  ): Promise<void> {
    await this.sendText(externalSessionId, recipientJid, text);
  }

  // /me is the same call sendToSelf makes; its jid is the paired number. The
  // hash is taken here so nothing above the port ever holds the number itself.
  async sessionNumberSha256(externalSessionId: string): Promise<string | null> {
    const me = asRecord(await this.call("GET", `/api/${externalSessionId}/me`));
    const number = toChatId(str(me.jid, "jid"));
    return number ? hashToken(number) : null;
  }

  async listGroups(
    externalSessionId: string,
  ): Promise<Array<{ jid: string; name: string | null }>> {
    const rows = await this.call("GET", `/api/${externalSessionId}/groups`);
    if (!Array.isArray(rows)) throw new Error("waapi groups: expected array");
    return rows.map((r) => {
      const g = asRecord(r);
      return {
        jid: str(g.jid, "jid"),
        name: typeof g.name === "string" && g.name.length > 0 ? g.name : null,
      };
    });
  }

  private async sendText(session: string, chatId: string, text: string): Promise<void> {
    await this.call("POST", "/api/sendText", { session, chat_id: chatId, text });
  }
}
