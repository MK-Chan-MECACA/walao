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

  // Tier 0 outbound: deliver text to the session owner's own "Message Yourself"
  // chat. Deliberately takes NO recipient — everything Tier 0 sends goes through
  // this method, so the spec §46 boundary holds for every non-opted-in user.
  sendToSelf(externalSessionId: string, text: string): Promise<void>;

  // Tier 1 outbound (spec §47–48): deliver text to another JID. Never call
  // directly — tier1.ts owns the opt-in check and the recipient "Yes" handshake.
  sendToRecipient(externalSessionId: string, recipientJid: string, text: string): Promise<void>;

  // SHA-256 of the paired WhatsApp number, or null if the session is not paired
  // yet. Hashed inside the adapter (spec §233) so the raw number never reaches
  // WALAO's storage — the Trial only needs to tell two numbers apart, never to
  // read one. Metadata only.
  sessionNumberSha256(externalSessionId: string): Promise<string | null>;

  // Group titles for a session. Providers may not carry the chat name on
  // message events (WAAPI does not), so discovery registers groups unnamed and
  // names are backfilled from here. Metadata only — never message content.
  listGroups(externalSessionId: string): Promise<Array<{ jid: string; name: string | null }>>;
}
