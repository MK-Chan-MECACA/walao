import type { GatewayPort, NormalizedEvent } from "./port.ts";

// WAAPI prototype adapter. This is the ONLY module that knows WAAPI's wire shape.
// Verified against commit fa1c2fe (2026-07-26); re-verify payload shape before
// relying on it (spec §Further Notes).
//
// Expected payload (message event):
//   { "event":"message", "session":"<id>",
//     "payload": { "id","chatId","chatName","from","fromMe","timestamp","body","hasMedia" } }

function asRecord(v: unknown): Record<string, unknown> {
  if (typeof v !== "object" || v === null) throw new Error("payload is not an object");
  return v as Record<string, unknown>;
}

function str(v: unknown, field: string): string {
  if (typeof v !== "string" || v.length === 0) throw new Error(`missing/invalid ${field}`);
  return v;
}

export class WaapiGateway implements GatewayPort {
  parse(payload: unknown): NormalizedEvent {
    const root = asRecord(payload);
    // ponytail: only message events mapped; add WAAPI session-status event
    // mapping once its wire shape is verified against a live gateway.
    if (root.event !== "message") throw new Error(`unsupported event: ${String(root.event)}`);
    const sessionExternalId = str(root.session, "session");
    const msg = asRecord(root.payload);

    // WAAPI timestamps are unix seconds.
    const ts = msg.timestamp;
    if (typeof ts !== "number" || !Number.isFinite(ts)) throw new Error("missing/invalid timestamp");

    return {
      type: "message",
      sessionExternalId,
      groupJid: str(msg.chatId, "chatId"),
      groupName: typeof msg.chatName === "string" ? msg.chatName : null,
      externalMessageId: str(msg.id, "id"),
      senderRef: typeof msg.from === "string" ? msg.from : null,
      text: typeof msg.body === "string" ? msg.body : "",
      sentAt: new Date(ts * 1000),
      fromMe: msg.fromMe === true,
    };
  }

  // ponytail: needs the WAAPI REST client (create session + fetch QR/code);
  // wire it when a real gateway is provisioned. FakeGateway covers ticket 3.
  startPairing(): Promise<{ externalSessionId: string; pairingCode: string }> {
    return Promise.reject(new Error("WAAPI pairing not implemented"));
  }

  // ponytail: needs the WAAPI REST client (send to the session's own JID);
  // wire it when a real gateway is provisioned. FakeGateway covers ticket 7.
  sendToSelf(): Promise<void> {
    return Promise.reject(new Error("WAAPI sendToSelf not implemented"));
  }
}
