// The replaceable gateway boundary. Nothing above this port may depend on any
// provider's (e.g. WAAPI's) wire schema — the port converts provider payloads
// into WALAO's internal events.

export type NormalizedEvent = {
  type: "message";
  sessionExternalId: string; // maps to whatsapp_sessions.external_session_id
  groupJid: string; // external group JID within the session
  groupName: string | null;
  externalMessageId: string; // idempotency key together with the session
  senderRef: string | null;
  text: string;
  sentAt: Date;
  fromMe: boolean; // system echo; excluded from processing by later tickets
};

export type SessionStatus = "connected" | "disconnected" | "re_pair_required";

// Gateway-reported connection state change for a session.
export type NormalizedStatus = {
  type: "status";
  sessionExternalId: string;
  status: SessionStatus;
};

export type GatewayEvent = NormalizedEvent | NormalizedStatus;

export interface GatewayPort {
  // Convert a raw provider webhook payload (already JSON-parsed) into WALAO's
  // internal event. Throw if the payload is not a recognizable event.
  parse(payload: unknown): GatewayEvent;

  // Begin pairing a new WhatsApp account. Returns the provider session id the
  // gateway will use in webhooks plus the code/QR the user completes pairing with.
  startPairing(): Promise<{ externalSessionId: string; pairingCode: string }>;
}
