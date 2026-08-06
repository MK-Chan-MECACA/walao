import type pg from "pg";

type Db = pg.Pool | pg.PoolClient;

// Two ways a person shows up as a raw id instead of a name: the message event
// carried no push_name (sender_name is NULL), or the body mentions them the way
// WhatsApp writes mentions — the bare id, "@30558843351102". Both resolve from
// the same place: another message the same sender sent while a name was known.
// One lookup per read, scoped to the Account, so no name crosses tenants.
export type SenderNames = {
  nameFor(senderRef: string | null, senderName: string | null): string | null;
  resolveMentions(text: string): string;
};

// Same treatment for a stored Summary. New summaries are written from messages
// whose mentions are already resolved, but one written before this existed has
// the raw ids baked into its item text — and those summaries are read for 90
// days. Every section is an array of {text, source_message_ids}; anything else
// in the payload passes through untouched.
export function resolvePayloadNames<T>(names: SenderNames, payload: T): T {
  const out: Record<string, unknown> = {};
  for (const [section, items] of Object.entries(payload as Record<string, unknown>)) {
    out[section] = Array.isArray(items)
      ? items.map((it) => {
          const text = (it as { text?: unknown })?.text;
          return typeof text === "string" ? { ...it, text: names.resolveMentions(text) } : it;
        })
      : items;
  }
  return out as T;
}

export async function loadSenderNames(db: Db, userId: string): Promise<SenderNames> {
  // Contacts first, messages second, so a name someone posted under wins over
  // the address book entry: push_name is what the Group sees them as today.
  const { rows } = await db.query(
    `SELECT ref, name FROM (
       SELECT c.jid AS ref, c.name AS name, 0 AS pri
         FROM contacts c
         JOIN whatsapp_sessions s ON s.id = c.session_id
        WHERE s.user_id = $1
       UNION ALL
       SELECT m.ref, m.name, 1 AS pri FROM (
         SELECT DISTINCT ON (sender_ref) sender_ref AS ref, sender_name AS name
           FROM messages
          WHERE user_id = $1 AND sender_ref IS NOT NULL AND sender_name IS NOT NULL
          ORDER BY sender_ref, sent_at DESC
       ) m
     ) names
     ORDER BY pri`,
    [userId],
  );
  const byPerson = new Map<string, string>();
  for (const r of rows) byPerson.set(person(r.ref as string), r.name as string);
  return {
    nameFor: (senderRef, senderName) =>
      senderName ?? (senderRef ? (byPerson.get(person(senderRef)) ?? null) : null),
    resolveMentions: (text) =>
      text.replace(/@(\d{5,})/g, (whole, digits: string) => {
        const name = byPerson.get(digits);
        return name ? `@${name}` : whole;
      }),
  };
}

// The person behind a JID, which is not the JID: a message arrives from one
// linked device ("112476687458485:90@lid" — the :90 is the device), the contact
// list stores the person ("112476687458485@lid"), and a mention writes the bare
// id. All three are the same human, and only the leading digits say so.
function person(jid: string): string {
  return (jid.split("@")[0] ?? "").split(":")[0] ?? "";
}
