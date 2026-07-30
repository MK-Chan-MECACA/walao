import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createPool, migrate, type Pool } from "../src/db.ts";
import { createApp } from "../src/app.ts";
import { signHmac, hashToken } from "../src/crypto.ts";
import type { Config } from "../src/config.ts";
import type { GatewayEvent, GatewayPort, SessionStatus } from "../src/gateway/port.ts";

export const WEBHOOK_SECRET = "test-secret";

export function testConfig(): Config {
  return {
    databaseUrl: process.env.DATABASE_URL as string,
    webhookSecret: WEBHOOK_SECRET,
    encKey: randomBytes(32),
    freshnessSeconds: 300,
    port: 0,
  };
}

// Fake GatewayPort: understands a simple synthetic payload so tests never depend
// on any real provider's wire shape. Real HMAC ingress still runs.
export class FakeGateway implements GatewayPort {
  private pairCount = 0;

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
  reset: () => Promise<void>;
  close: () => Promise<void>;
};

export async function makeHarness(): Promise<Harness> {
  const config = testConfig();
  const pool = createPool(config.databaseUrl);
  await migrate(pool);
  const app = createApp({ pool, gateway: new FakeGateway(), config });
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
    async reset() {
      await pool.query(
        `TRUNCATE messages, consent_records, coverage_gaps, groups, whatsapp_sessions, users, ingest_events RESTART IDENTITY CASCADE`,
      );
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
