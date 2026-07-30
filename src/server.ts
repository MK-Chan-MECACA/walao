import { createServer } from "node:http";
import { loadConfig } from "./config.ts";
import { createPool, migrate } from "./db.ts";
import { createApp } from "./app.ts";
import { WaapiGateway } from "./gateway/waapi.ts";
import { purgeExpired } from "./retention.ts";

// Real entrypoint. Boots the schema, serves the webhook + API, and drains the
// queue on a simple interval. A single-process poll loop is enough for the
// walking skeleton; a dedicated worker can come later if throughput needs it.
// ponytail: interval poll drain, move to LISTEN/NOTIFY or a worker if latency matters.
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  await migrate(pool);

  const app = createApp({ pool, gateway: new WaapiGateway(), config });

  const timer = setInterval(() => {
    app.drain().catch((err) => console.error("drain error", err));
    // ponytail: expiry purge piggybacks the 1s drain tick; split to its own
    // slower timer if the delete scan ever shows up in load.
    purgeExpired(pool).catch((err) => console.error("purge error", err));
  }, 1000);
  timer.unref();

  createServer(app.handler).listen(config.port, () => {
    console.log(`WALAO listening on :${config.port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
