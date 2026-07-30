// Env config. Kept dumb on purpose — read once, fail loud if a required secret
// is missing (input validation at a trust boundary).

export type Config = {
  databaseUrl: string;
  webhookSecret: string;
  encKey: Buffer; // 32 bytes for AES-256-GCM
  freshnessSeconds: number;
  port: number;
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
    encKey,
    freshnessSeconds: Number(process.env.WALAO_FRESHNESS_SECONDS ?? 300),
    port: Number(process.env.PORT ?? 3000),
  };
}
