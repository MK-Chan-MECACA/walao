// Ops one-shot: pull contact names now instead of waiting for the 10-minute
// metadata timer — used right after a deploy so existing summaries stop showing
// raw "@40102864666870" ids on the next page load.
//
// Usage: node scripts/sync-contacts-now.ts
import { loadConfig } from "../src/config.ts";
import { createPool } from "../src/db.ts";
import { WaapiGateway } from "../src/gateway/waapi.ts";
import { syncContacts } from "../src/subscriptions.ts";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const gateway = new WaapiGateway(
  config.waapiBaseUrl,
  config.waapiApiKey,
  config.webhookUrl,
  config.webhookSecret,
);

console.log(`contacts written: ${await syncContacts(pool, gateway)}`);
const { rows } = await pool.query(
  `SELECT s.external_session_id, count(*) AS names
   FROM contacts c JOIN whatsapp_sessions s ON s.id = c.session_id
   GROUP BY 1`,
);
for (const r of rows) console.log(`  ${r.external_session_id}: ${r.names} names stored`);
await pool.end();
