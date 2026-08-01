import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createPool, migrate, type Pool } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { signHmac, hashToken, encrypt } from "../src/crypto.ts";
import type { Config } from "../src/config.ts";
import type { GatewayEvent, GatewayPort, SessionStatus } from "../src/gateway/port.ts";
import {
  emptySummary,
  processSummaryJobs,
  type SummaryPayload,
  type SummarizerInput,
  type SummarizerPort,
  type SummarizerResult,
} from "../src/summarize.ts";
import { deliverSummaries } from "../src/deliver.ts";
import type { AnswererInput, AnswererPort, AnswererResult } from "../src/ask.ts";

export const WEBHOOK_SECRET = "test-secret";
export const OPERATOR_SECRET = "test-operator-secret";

export function testConfig(): Config {
  return {
    databaseUrl: process.env.DATABASE_URL as string,
    webhookSecret: WEBHOOK_SECRET,
    operatorSecret: OPERATOR_SECRET,
    encKey: randomBytes(32),
    freshnessSeconds: 300,
    port: 0,
    // Unused: every test drives the FakeGateway, never a real WAAPI instance.
    waapiBaseUrl: "http://127.0.0.1:1",
    waapiApiKey: "",
    // Unused: every test drives FakeSummarizer, never a real model.
    anthropicApiKey: "",
    summarizerModel: "test-model",
  };
}

// Fake GatewayPort: understands a simple synthetic payload so tests never depend
// on any real provider's wire shape. Real HMAC ingress still runs.
export class FakeGateway implements GatewayPort {
  private pairCount = 0;
  // Every outbound send, captured for assertions. The only routing datum the
  // port allows is the session id — the Tier 0 boundary tests rely on that.
  sends: { sessionExternalId: string; text: string }[] = [];

  parse(payload: unknown): GatewayEvent {
    const p = payload as Record<string, unknown>;
    if (p.kind === "status") {
      return {
        type: "status",
        sessionExternalId: String(p.session),
        status: p.status as SessionStatus,
      };
    }
    if (p.kind !== "message") throw new Error("not a message");
    return {
      type: "message",
      sessionExternalId: String(p.session),
      groupJid: String(p.chatId),
      groupName: (p.chatName as string) ?? null,
      externalMessageId: String(p.id),
      senderRef: (p.from as string) ?? null,
      text: typeof p.text === "string" ? p.text : "",
      sentAt: new Date(p.sentAt as string),
      fromMe: p.fromMe === true,
    };
  }

  async startPairing(): Promise<{ externalSessionId: string; pairingCode: string }> {
    this.pairCount++;
    return { externalSessionId: `fake-sess-${this.pairCount}`, pairingCode: "FAKE-1234" };
  }

  async sendToSelf(sessionExternalId: string, text: string): Promise<void> {
    this.sends.push({ sessionExternalId, text });
  }

  // Tier 1 sends land in their own array so Tier 0 boundary assertions on
  // `sends` stay exact.
  recipientSends: { sessionExternalId: string; recipientJid: string; text: string }[] = [];

  async sendToRecipient(
    sessionExternalId: string,
    recipientJid: string,
    text: string,
  ): Promise<void> {
    this.recipientSends.push({ sessionExternalId, recipientJid, text });
  }

  // Group titles the fake gateway will report, keyed by session id. Tests that
  // exercise the name backfill set this; everyone else gets an empty list.
  groupNames: Record<string, Array<{ jid: string; name: string | null }>> = {};

  async listGroups(
    sessionExternalId: string,
  ): Promise<Array<{ jid: string; name: string | null }>> {
    return this.groupNames[sessionExternalId] ?? [];
  }
}

// Fake SummarizerPort — the AI-pipeline test seam: canned structured JSON out,
// every received input recorded so tests can assert on what the model was fed.
export class FakeSummarizer implements SummarizerPort {
  canned: unknown = {};
  calls: SummarizerInput[] = [];
  fail = false;

  async summarize(input: SummarizerInput): Promise<SummarizerResult> {
    this.calls.push(input);
    if (this.fail) throw new Error("summarizer unavailable");
    return {
      output: this.canned,
      model: "fake-model-1",
      promptVersion: "test-v1",
      inputTokens: 10,
      outputTokens: 5,
    };
  }
}

// Fake AnswererPort — same seam as FakeSummarizer: canned JSON out, every
// input recorded so tests can assert exactly what the model was fed.
export class FakeAnswerer implements AnswererPort {
  canned: unknown = {};
  calls: AnswererInput[] = [];

  async answer(input: AnswererInput): Promise<AnswererResult> {
    this.calls.push(input);
    return { output: this.canned, model: "fake-model-1", promptVersion: "test-v1" };
  }
}

export type SyntheticEvent = {
  kind: "message";
  session: string;
  id: string;
  chatId: string;
  chatName?: string;
  from?: string;
  text: string;
  sentAt: string; // ISO
  fromMe?: boolean;
};

export function buildEvent(over: Partial<SyntheticEvent> = {}): SyntheticEvent {
  return {
    kind: "message",
    session: "sess-1",
    id: "msg-1",
    chatId: "group-1@g.us",
    chatName: "Purchasing",
    from: "alice@s.whatsapp.net",
    text: "Approved the RM500 order",
    sentAt: new Date().toISOString(),
    ...over,
  };
}

export type Harness = {
  pool: Pool;
  config: Config;
  baseUrl: string;
  postWebhook: (event: unknown, opts?: { signature?: string }) => Promise<number>;
  getMessages: (token: string) => Promise<{ status: number; messages: unknown[] }>;
  drain: () => Promise<number>;
  api: (
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<{ status: number; body: unknown }>;
  seedUser: (token: string) => Promise<string>;
  seedSession: (userId: string, externalSessionId: string) => Promise<string>;
  seedGroup: (sessionId: string, externalJid: string, enabled?: boolean) => Promise<string>;
  seedMessage: (
    groupId: string,
    externalId: string,
    sentAt: string,
    opts?: { text?: string; fromMe?: boolean },
  ) => Promise<string>;
  seedSummary: (
    userId: string,
    groupId: string,
    payload?: Partial<SummaryPayload>,
    opts?: { at?: Date; language?: string },
  ) => Promise<string>;
  op: (method: string, path: string, body?: unknown, secret?: string) => Promise<Response>;
  // Every login code the app "mailed", in order — the mail seam for ticket 18.
  codes: { email: string; code: string }[];
  gateway: FakeGateway;
  summarizer: FakeSummarizer;
  answerer: FakeAnswerer;
  summarize: () => Promise<number>;
  deliver: () => Promise<number>;
  reset: () => Promise<void>;
  close: () => Promise<void>;
};

export async function makeHarness(): Promise<Harness> {
  const config = testConfig();
  const pool = createPool(config.databaseUrl);
  await migrate(pool);
  const gateway = new FakeGateway();
  const answerer = new FakeAnswerer();
  const codes: { email: string; code: string }[] = [];
  const app = createApp({
    pool,
    gateway,
    answerer,
    config,
    sendCode: async (email, code) => {
      codes.push({ email, code });
    },
  });
  const summarizer = new FakeSummarizer();
  const server: Server = createServer(app.handler);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    pool,
    config,
    baseUrl,
    async postWebhook(event, opts) {
      const raw = Buffer.from(JSON.stringify(event));
      const signature = opts?.signature ?? signHmac(raw, WEBHOOK_SECRET);
      const res = await fetch(`${baseUrl}/webhooks/gateway`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-walao-signature": signature },
        body: raw,
      });
      return res.status;
    },
    async getMessages(token) {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.status !== 200) return { status: res.status, messages: [] };
      const body = (await res.json()) as { messages: unknown[] };
      return { status: res.status, messages: body.messages };
    },
    drain: () => app.drain(),
    async api(token, method, path, body) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    async seedUser(token) {
      const { rows } = await pool.query(
        `INSERT INTO users (api_token_sha256) VALUES ($1) RETURNING id`,
        [hashToken(token)],
      );
      return rows[0].id;
    },
    async seedSession(userId, externalSessionId) {
      const { rows } = await pool.query(
        `INSERT INTO whatsapp_sessions (user_id, external_session_id) VALUES ($1, $2) RETURNING id`,
        [userId, externalSessionId],
      );
      return rows[0].id;
    },
    async seedGroup(sessionId, externalJid, enabled = true) {
      const { rows } = await pool.query(
        `INSERT INTO groups (session_id, external_jid, enabled) VALUES ($1, $2, $3) RETURNING id`,
        [sessionId, externalJid, enabled],
      );
      return rows[0].id;
    },
    // Store a message directly with a controlled sent_at — for scheduler and
    // summary tests, whose timelines sit outside the webhook freshness window
    // by design. Returns the message id so canned summaries can cite it.
    async seedMessage(groupId, externalId, sentAt, opts) {
      const { rows } = await pool.query(
        `INSERT INTO messages
           (user_id, session_id, group_id, external_id, sent_at, from_me, body_ciphertext, expires_at)
         SELECT s.user_id, g.session_id, g.id, $2, $3, $5, $4, $3::timestamptz + interval '30 days'
         FROM groups g JOIN whatsapp_sessions s ON s.id = g.session_id
         WHERE g.id = $1
         RETURNING id`,
        [groupId, externalId, sentAt, encrypt(opts?.text ?? "seeded", config.encKey), opts?.fromMe ?? false],
      );
      return rows[0].id;
    },
    // One-hour summary window ending at `at` (default now); created_at follows
    // `at` so recency-filtered surfaces see the summary where its window sits.
    async seedSummary(userId, groupId, payload = {}, opts) {
      const at = opts?.at ?? new Date();
      const { rows } = await pool.query(
        `INSERT INTO summaries
           (user_id, group_id, language, window_start, window_end, payload,
            model, prompt_version, input_tokens, output_tokens, duration_ms, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 't', 't', 0, 0, 0, $5) RETURNING id`,
        [
          userId,
          groupId,
          opts?.language ?? "en",
          new Date(at.getTime() - 3600_000),
          at,
          JSON.stringify({ ...emptySummary(), ...payload }),
        ],
      );
      return rows[0].id;
    },
    op(method, path, body, secret = OPERATOR_SECRET) {
      return fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          "x-walao-operator-secret": secret,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    },
    codes,
    gateway,
    summarizer,
    answerer,
    summarize: () => processSummaryJobs(pool, summarizer, config),
    deliver: () => deliverSummaries(pool, gateway),
    async reset() {
      codes.length = 0;
      gateway.sends = [];
      gateway.recipientSends = [];
      summarizer.canned = {};
      summarizer.calls = [];
      summarizer.fail = false;
      answerer.canned = {};
      answerer.calls = [];
      await pool.query(
        `TRUNCATE messages, summaries, summary_jobs, summary_schedules, consent_records, coverage_gaps, groups, whatsapp_sessions, users, ingest_events, privacy_audit, quality_reviews RESTART IDENTITY CASCADE`,
      );
      // system_halt is a singleton row, not per-test data — un-halt, don't truncate.
      await pool.query(`UPDATE system_halt SET halted = false`);
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
    },
  };
}

export async function countIngestEvents(pool: Pool): Promise<number> {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ingest_events`);
  return rows[0].n;
}
