// Dev-only seed: there is no signup route, so a local tenant has to be created
// directly. Makes one user + a connected session + one enabled group, and
// prints the bearer token to use against /v1. Idempotent on the token.
//
// Usage: node scripts/seed-dev.ts [token]
import { loadConfig } from "../src/config.ts";
import { createPool } from "../src/db.ts";
import { hashToken } from "../src/crypto.ts";

const token = process.argv[2] ?? "dev-token";
const pool = createPool(loadConfig().databaseUrl);

const user = await pool.query(
  `INSERT INTO users (api_token_sha256) VALUES ($1)
   ON CONFLICT (api_token_sha256) DO UPDATE SET api_token_sha256 = EXCLUDED.api_token_sha256
   RETURNING id`,
  [hashToken(token)],
);
const userId = user.rows[0].id;

const session = await pool.query(
  `INSERT INTO whatsapp_sessions (user_id, external_session_id, status)
   VALUES ($1, $2, 'connected')
   ON CONFLICT (external_session_id) DO UPDATE SET status = 'connected'
   RETURNING id, external_session_id`,
  [userId, `dev-session-${userId.slice(0, 8)}`],
);
const sessionId = session.rows[0].id;

const group = await pool.query(
  `INSERT INTO groups (session_id, external_jid, name, enabled)
   VALUES ($1, 'dev@g.us', 'Dev Group', true)
   ON CONFLICT (session_id, external_jid) DO UPDATE SET enabled = true
   RETURNING id`,
  [sessionId],
);

console.log(
  JSON.stringify(
    {
      bearer: token,
      user_id: userId,
      session_id: sessionId,
      external_session_id: session.rows[0].external_session_id,
      group_id: group.rows[0].id,
      group_jid: "dev@g.us",
    },
    null,
    2,
  ),
);
await pool.end();
