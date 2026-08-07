import type pg from "pg";
import type { SelfIdentity } from "./gateway/port.ts";

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

// Was the Account holder @mentioned in this text? WhatsApp writes a mention as
// the bare digits of one of the person's two ids ("@30558843351102") — the same
// pattern resolveMentions rewrites for display, which is why this lives here.
//
// Three things carry the correctness: both id forms are tried (a sender's client
// writes whichever one it holds), person() collapses a device suffix, and the
// trailing (?!\d) stops "@601234567891234" matching a self id of 60123456789.
// The @Name form is tried too: past raw-message expiry the only text left is the
// Summary item, where the digits have already been rewritten to the display name.
// Unknown identity is false, never true — a guessed ping is worse than a missed
// one, and the daily digest carries the item either way.
export function mentionsSelf(text: string, self: SelfIdentity | null): boolean {
  if (!self) return false;
  const digits = [self.phone, self.lid]
    .map((id) => (id ? person(id) : ""))
    .filter((d) => d.length > 0);
  if (digits.some((d) => new RegExp(`@${d}(?!\\d)`).test(text))) return true;
  if (!self.name) return false;
  return new RegExp(`@${self.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
}

// The person behind a JID, which is not the JID: a message arrives from one
// linked device ("112476687458485:90@lid" — the :90 is the device), the contact
// list stores the person ("112476687458485@lid"), and a mention writes the bare
// id. All three are the same human, and only the leading digits say so.
function person(jid: string): string {
  return (jid.split("@")[0] ?? "").split(":")[0] ?? "";
}
