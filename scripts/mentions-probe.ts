// Ops read-only probe: which @mention ids in stored messages still have no
// name, and would the gateway's contact list name them? Answers the one
// question the fix turns on — whether GET /api/{session}/contacts carries the
// LID-addressed people who are mentioned but have never sent a message.
//
// Usage: node scripts/mentions-probe.ts [hours=72]
import { loadConfig } from "../src/config.ts";
import { createPool } from "../src/db.ts";
import { decrypt } from "../src/crypto.ts";
import { accountKey } from "../src/accounts.ts";
import { loadSenderNames } from "../src/sender-names.ts";

const hours = Number(process.argv[2] ?? 72);
const config = loadConfig();
const pool = createPool(config.databaseUrl);

const sessions = await pool.query(
  `SELECT s.id, s.external_session_id, s.user_id FROM whatsapp_sessions s WHERE s.status = 'connected'`,
);
console.log(`connected sessions: ${sessions.rowCount}`);

for (const s of sessions.rows) {
  const msgs = await pool.query(
    `SELECT sender_ref, sender_name, body_ciphertext FROM messages
     WHERE user_id = $1 AND sent_at > now() - ($2 || ' hours')::interval`,
    [s.user_id, String(hours)],
  );
  const key = await accountKey(pool, config, s.user_id);
  const known = new Map<string, string>();
  for (const m of msgs.rows) {
    if (m.sender_ref && m.sender_name) known.set(String(m.sender_ref).split("@")[0], m.sender_name);
  }
  const mentioned = new Set<string>();
  for (const m of msgs.rows) {
    for (const [, digits] of decrypt(m.body_ciphertext, key).matchAll(/@(\d{5,})/g)) {
      mentioned.add(digits);
    }
  }
  const unresolved = [...mentioned].filter((d) => !known.has(d));
  console.log(
    `session ${s.external_session_id}: messages=${msgs.rowCount} senders_named=${known.size} mentioned=${mentioned.size} unresolved=${unresolved.length}`,
  );
  console.log(`  unresolved ids: ${unresolved.join(", ") || "(none)"}`);

  const res = await fetch(`${config.waapiBaseUrl}/api/${s.external_session_id}/contacts`, {
    headers: { Authorization: `Bearer ${config.waapiApiKey}` },
  });
  if (!res.ok) {
    console.log(`  contacts: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    continue;
  }
  const contacts = (await res.json()) as Array<Record<string, unknown>>;
  const byLocal = new Map<string, Record<string, unknown>>();
  for (const c of contacts) {
    if (typeof c.jid === "string") byLocal.set(c.jid.split("@")[0], c);
  }
  const lidCount = contacts.filter((c) => String(c.jid ?? "").endsWith("@lid")).length;
  console.log(`  contacts: total=${contacts.length} lid_addressed=${lidCount}`);
  console.log(`  sample: ${JSON.stringify(contacts.slice(0, 3))}`);
  const covered = unresolved.filter((d) => byLocal.has(d));
  console.log(`  contacts cover ${covered.length}/${unresolved.length} unresolved`);
  for (const d of covered) console.log(`    ${d} -> ${JSON.stringify(byLocal.get(d))}`);

  // The check that actually matters: what the read path resolves after the
  // sync, not what the gateway could resolve in principle.
  const names = await loadSenderNames(pool, s.user_id);
  const stillRaw = [...mentioned].filter((d) => names.resolveMentions(`@${d}`) === `@${d}`);
  console.log(`  read path: ${mentioned.size - stillRaw.length}/${mentioned.size} mentions named`);
  console.log(`  still raw: ${stillRaw.join(", ") || "(none)"}`);
  const unnamedSenders = await pool.query(
    `SELECT count(*) FROM messages m
     WHERE m.user_id = $1 AND m.sent_at > now() - ($2 || ' hours')::interval
       AND m.sender_name IS NULL
       AND NOT EXISTS (SELECT 1 FROM contacts c JOIN whatsapp_sessions ws ON ws.id = c.session_id
                       WHERE ws.user_id = $1
                         AND split_part(c.jid, '@', 1)
                             = split_part(split_part(m.sender_ref, '@', 1), ':', 1))`,
    [s.user_id, String(hours)],
  );
  console.log(`  messages whose sender still has no name: ${unnamedSenders.rows[0].count}`);
}

await pool.end();
