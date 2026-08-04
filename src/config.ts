import { DEFAULT_MODEL } from "./summarizer/anthropic.ts";

// Env config. Kept dumb on purpose — read once, fail loud if a required secret
// is missing (input validation at a trust boundary).

export type Config = {
  databaseUrl: string;
  webhookSecret: string;
  operatorSecret: string; // authorizes the product-wide halt switch
  encKey: Buffer; // 32 bytes for AES-256-GCM
  freshnessSeconds: number;
  port: number;
  waapiBaseUrl: string;
  waapiApiKey: string; // empty until a gateway is provisioned; adapter fails loud on use
  webhookUrl: string; // where the WAAPI gateway sends webhooks back to
  anthropicApiKey: string; // empty => LocalSummarizer echo stand-in, no AI calls
  summarizerModel: string;
  resendApiKey: string; // empty => login codes go to the log, not to a mailbox
  mailFrom: string;
};

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export function loadConfig(): Config {
  const encKey = Buffer.from(required("WALAO_ENC_KEY"), "base64");
  if (encKey.length !== 32) {
    throw new Error("WALAO_ENC_KEY must be 32 bytes (base64-encoded) for AES-256-GCM");
  }
  return {
    databaseUrl: required("DATABASE_URL"),
    webhookSecret: required("WALAO_WEBHOOK_SECRET"),
    operatorSecret: required("WALAO_OPERATOR_SECRET"),
    encKey,
    freshnessSeconds: Number(process.env.WALAO_FRESHNESS_SECONDS ?? 300),
    port: Number(process.env.PORT ?? 3000),
    // Not required(): the fakes cover every test, and a WALAO instance boots
    // fine without a gateway — the adapter throws when actually asked to talk.
    waapiBaseUrl: (process.env.WAAPI_BASE_URL ?? "http://localhost:8080").replace(/\/+$/, ""),
    waapiApiKey: process.env.WAAPI_API_KEY ?? "",
    webhookUrl: (process.env.WALAO_WEBHOOK_URL ?? "http://localhost:3000/webhooks/gateway").replace(/\/+$/, ""),
    // Also not required(): without a key the server boots on the local echo
    // summarizer, so the pipeline stays runnable with no AI spend.
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
    summarizerModel: process.env.WALAO_SUMMARIZER_MODEL ?? DEFAULT_MODEL,
    // Same pattern again: without a key the code goes to the log, so dev and
    // tests run with no mail spend and no deliverability setup.
    resendApiKey: process.env.RESEND_API_KEY ?? "",
    mailFrom: process.env.WALAO_MAIL_FROM ?? "WALAO <onboarding@resend.dev>",
  };
}
