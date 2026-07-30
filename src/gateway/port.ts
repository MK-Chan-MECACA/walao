// The replaceable gateway boundary. Nothing above this port may depend on any
// provider's (e.g. WAAPI's) wire schema — the port converts provider payloads
// into WALAO's internal NormalizedEvent.

export type NormalizedEvent = {
  sessionExternalId: string; // maps to whatsapp_sessions.external_session_id
  groupJid: string; // external group JID within the session
  groupName: string | null;
  externalMessageId: string; // idempotency key together with the session
  senderRef: string | null;
  text: string;
  sentAt: Date;
  fromMe: boolean; // system echo; excluded from processing by later tickets
};

export interface GatewayPort {
  // Convert a raw provider webhook payload (already JSON-parsed) into WALAO's
  // internal event. Throw if the payload is not a recognizable message event.
  parse(payload: unknown): NormalizedEvent;
}
