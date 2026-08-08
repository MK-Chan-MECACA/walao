import { createServer } from "node:http";
import { loadConfig } from "./config.ts";
import { createPool, migrate } from "./db.ts";
import { createApp } from "./app.ts";
import { WaapiGateway } from "./gateway/waapi.ts";
import { purgeExpired } from "./retention.ts";
import { tickScheduler } from "./scheduler.ts";
import { deliverDigests, deliverSummaries, tickDigests } from "./deliver.ts";
import { processSummaryJobs } from "./summarize.ts";
import { backfillGroupNames, syncContacts } from "./subscriptions.ts";
import { evictIdleSessions } from "./connections.ts";
import { LocalSummarizer } from "./summarizer/local.ts";
import { AnthropicSummarizer } from "./summarizer/anthropic.ts";
import { LocalAnswerer } from "./answerer/local.ts";
import { AnthropicAnswerer, DEFAULT_ANSWERER_MODEL } from "./answerer/anthropic.ts";
import type { AnswererPort } from "./ask.ts";
import { LocalPicker } from "./picker/local.ts";
import { AnthropicPicker, DEFAULT_PICKER_MODEL } from "./picker/anthropic.ts";
import type { PickerPort } from "./pick.ts";

// Real entrypoint. Boots the schema, serves the webhook + API, and drains the
// queue on a simple interval. A single-process poll loop is enough for the
// walking skeleton; a dedicated worker can come later if throughput needs it.
// ponytail: interval poll drain, move to LISTEN/NOTIFY or a worker if latency matters.
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  await migrate(pool);

  const gateway = new WaapiGateway(config.waapiBaseUrl, config.waapiApiKey, config.webhookUrl, config.webhookSecret);
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
  // Same conditional as the summarizer, same reason: Ask WALAO stays runnable
  // locally without AI spend, and the port is identical either way.
  const answerer: AnswererPort = config.anthropicApiKey
    ? new AnthropicAnswerer(config.anthropicApiKey)
    : new LocalAnswerer();
  console.log(
    config.anthropicApiKey
      ? `answerer: ${DEFAULT_ANSWERER_MODEL}`
      : "answerer: local echo (no ANTHROPIC_API_KEY — answers quote retrieval verbatim)",
  );
  // Same conditional again, same reason: the pick stays runnable locally with
  // no AI spend, on an identical port.
  const picker: PickerPort = config.anthropicApiKey
    ? new AnthropicPicker(config.anthropicApiKey)
    : new LocalPicker();
  console.log(
    config.anthropicApiKey
      ? `picker: ${DEFAULT_PICKER_MODEL}`
      : "picker: local rule (no ANTHROPIC_API_KEY — tagged action items first, no judgement)",
  );
  console.log(
    config.resendApiKey
      ? `mail: resend, from ${config.mailFrom}`
      : "mail: log only (no RESEND_API_KEY — login codes print here, no email is sent)",
  );
  const app = createApp({ pool, gateway, answerer, picker, config });

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
    deliverSummaries(pool, picker, config).catch((err) => console.error("delivery error", err));
    // Ticket 06: the digest clock writes the day's record for Accounts that
    // never open the web app, and this sends whatever record is due — one
    // message a day, whichever path wrote it.
    tickDigests(pool, picker, config).catch((err) => console.error("digest tick error", err));
    deliverDigests(pool, gateway, config.appUrl).catch((err) =>
      console.error("digest delivery error", err),
    );
  }, 1000);
  timer.unref();

  // Group titles are not on the message webhook, so unnamed groups are filled
  // from the gateway. Its own timer, not the 1s tick: this is a network call
  // and a name that cannot be resolved must not be retried every second.
  // 10 minutes, not 1: WhatsApp rate-limits group-metadata queries hard (429
  // rate-overlimit, then it closes the stream and the session drops), and a
  // group title nobody has seen yet can wait.
  const nameTimer = setInterval(() => {
    backfillGroupNames(pool, gateway).catch((err) =>
      console.error("group name backfill error", err),
    );
    // Contact names ride the same slow timer for the same reason: it is a
    // network call, and an address book does not change by the second.
    syncContacts(pool, gateway).catch((err) => console.error("contact sync error", err));
    // ponytail: eviction rides the 60s timer — a 14-day threshold does not care
    // about the minute. Move it to a daily cron if the scan ever costs anything.
    evictIdleSessions(pool).catch((err) => console.error("session eviction error", err));
  }, 600_000);
  nameTimer.unref();

  createServer(app.handler).listen(config.port, () => {
    console.log(`WALAO listening on :${config.port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
