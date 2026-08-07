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
  senderName: string | null; // sender's display name if the provider carries one
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

// The Account holder's own WhatsApp identity (migration 030). `phone` and `lid`
// are the two ways WhatsApp addresses one human, as bare digits — the form a
// mention is written in inside a message body.
export type SelfIdentity = {
  phone: string | null;
  lid: string | null;
  name: string | null;
};

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
  // yet. Hashed inside the adapter (spec §233) because the Trial only needs to
  // tell two numbers apart, never to read one, and a hash is the smallest thing
  // that does that. This is NOT a claim that the number never reaches storage —
  // sessionIdentity below deliberately stores the raw forms, for a use a hash
  // cannot serve. Metadata only.
  sessionNumberSha256(externalSessionId: string): Promise<string | null>;

  // The paired human's own identity: both of WhatsApp's addressing forms as
  // bare digits, plus the display name they post under. Raw, unlike the hash
  // above, because mention matching is a substring test against message bodies
  // and equality on a hash cannot perform it. Any field the gateway cannot name
  // comes back null. Metadata only — never message content.
  sessionIdentity(externalSessionId: string): Promise<SelfIdentity>;

  // Group titles and sizes for a session. Providers may not carry the chat name
  // on message events (WAAPI does not), so discovery registers groups unnamed
  // and names are backfilled from here. The member count is what tells two
  // same-named chats apart — a Community's announcement group and the Group it
  // announces to share a name, and only their size differs.
  // Metadata only — never message content.
  listGroups(
    externalSessionId: string,
  ): Promise<Array<{ jid: string; name: string | null; members: number | null }>>;

  // Display names for the JIDs this session knows. Message events only name
  // people who post, so someone who is only ever @mentioned has no name
  // anywhere else. Names and JIDs only — never message content.
  listContacts(externalSessionId: string): Promise<Array<{ jid: string; name: string }>>;
}
