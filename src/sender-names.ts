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

export async function loadSenderNames(db: Db, userId: string): Promise<SenderNames> {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (sender_ref) sender_ref, sender_name
     FROM messages
     WHERE user_id = $1 AND sender_ref IS NOT NULL AND sender_name IS NOT NULL
     ORDER BY sender_ref, sent_at DESC`,
    [userId],
  );
  const byRef = new Map<string, string>();
  const byLocal = new Map<string, string>();
  for (const r of rows) {
    const ref = r.sender_ref as string;
    const name = r.sender_name as string;
    byRef.set(ref, name);
    // "30558843351102@lid" and "6512345678@c.us" both mention as the local part.
    byLocal.set(ref.split("@")[0], name);
  }
  return {
    nameFor: (senderRef, senderName) =>
      senderName ?? (senderRef ? (byRef.get(senderRef) ?? null) : null),
    resolveMentions: (text) =>
      text.replace(/@(\d{5,})/g, (whole, digits: string) => {
        const name = byLocal.get(digits);
        return name ? `@${name}` : whole;
      }),
  };
}
