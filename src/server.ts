import { createServer } from "node:http";
import { loadConfig } from "./config.ts";
import { createPool, migrate } from "./db.ts";
import { createApp } from "./app.ts";
import { WaapiGateway } from "./gateway/waapi.ts";
import { purgeExpired } from "./retention.ts";
import { tickScheduler } from "./scheduler.ts";
import { deliverSummaries } from "./deliver.ts";
import { processSummaryJobs } from "./summarize.ts";
import { backfillGroupNames } from "./subscriptions.ts";
import { LocalSummarizer } from "./summarizer/local.ts";
import { AnthropicSummarizer } from "./summarizer/anthropic.ts";
import type { AnswererPort } from "./ask.ts";

// Real entrypoint. Boots the schema, serves the webhook + API, and drains the
// queue on a simple interval. A single-process poll loop is enough for the
// walking skeleton; a dedicated worker can come later if throughput needs it.
// ponytail: interval poll drain, move to LISTEN/NOTIFY or a worker if latency matters.
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  await migrate(pool);

  const gateway = new WaapiGateway(config.waapiBaseUrl, config.waapiApiKey);
  // Real model when a key is present, deterministic echo when it isn't, so the
  // pipeline stays runnable locally without AI spend. Same port either way.
  const summarizer = config.anthropicApiKey
    ? new AnthropicSummarizer(config.anthropicApiKey, config.summarizerModel)
    : new LocalSummarizer();
  console.log(
    config.anthropicApiKey
      ? `summarizer: ${config.summarizerModel}`
      : "summarizer: local echo (no ANTHROPIC_API_KEY — briefs will be verbatim, not condensed)",
  );
  // ponytail: real model client wired when one is provisioned; FakeAnswerer
  // covers ticket 11 (same status as WAAPI pairing/sendToSelf).
  const answerer: AnswererPort = {
    answer: () => Promise.reject(new Error("answerer not implemented")),
  };
  const app = createApp({ pool, gateway, answerer, config });

  const timer = setInterval(() => {
    app.drain().catch((err) => console.error("drain error", err));
    // ponytail: expiry purge piggybacks the 1s drain tick; split to its own
    // slower timer if the delete scan ever shows up in load.
    purgeExpired(pool).catch((err) => console.error("purge error", err));
    tickScheduler(pool).catch((err) => console.error("scheduler error", err));
    // Scheduler emits jobs, this drains them into summaries, delivery sends
    // them. All three share the tick: a job lands one tick after it is emitted
    // and delivers the tick after that — the same eventual-consistency the
    // ingest drain already relies on.
    processSummaryJobs(pool, summarizer, config).catch((err) =>
      console.error("summarize error", err),
    );
    deliverSummaries(pool, gateway).catch((err) => console.error("delivery error", err));
  }, 1000);
  timer.unref();

  // Group titles are not on the message webhook, so unnamed groups are filled
  // from the gateway. Its own timer, not the 1s tick: this is a network call
  // and a name that cannot be resolved must not be retried every second.
  const nameTimer = setInterval(() => {
    backfillGroupNames(pool, gateway).catch((err) =>
      console.error("group name backfill error", err),
    );
  }, 60_000);
  nameTimer.unref();

  createServer(app.handler).listen(config.port, () => {
    console.log(`WALAO listening on :${config.port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
