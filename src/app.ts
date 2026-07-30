import type { IncomingMessage, ServerResponse } from "node:http";
import type pg from "pg";
import type { GatewayPort } from "./gateway/port.ts";
import type { Config } from "./config.ts";
import { ingestWebhook } from "./ingest.ts";
import { drainQueue } from "./consumer.ts";
import { authenticate, listMessages } from "./api.ts";

export type App = {
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  drain: () => Promise<number>;
};

// Compose the system with an injectable GatewayPort — the whole-system test seam
// swaps in a fake gateway while everything else (ingress security, queue, store,
// API) runs for real against real Postgres.
export function createApp(deps: { pool: pg.Pool; gateway: GatewayPort; config: Config }): App {
  const { pool, gateway, config } = deps;

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void route(req, res).catch((err) => {
      console.error(err);
      send(res, 500, { error: "internal" });
    });
  };

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "POST" && url.pathname === "/webhooks/gateway") {
      const raw = await readRawBody(req);
      const sig = header(req, "x-walao-signature");
      const result = await ingestWebhook(pool, gateway, config, raw, sig);
      send(res, result.status, null);
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/messages") {
      const userId = await authenticate(pool, bearer(req));
      if (!userId) {
        send(res, 401, { error: "unauthorized" });
        return;
      }
      send(res, 200, { messages: await listMessages(pool, config, userId) });
      return;
    }

    send(res, 404, { error: "not_found" });
  }

  return { handler, drain: () => drainQueue(pool, gateway, config) };
}

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function header(req: IncomingMessage, name: string): string {
  const v = req.headers[name];
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

function bearer(req: IncomingMessage): string | null {
  const auth = header(req, "authorization");
  const m = auth.match(/^Bearer (.+)$/);
  return m ? m[1] : null;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (body === null) {
    res.writeHead(status);
    res.end();
    return;
  }
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(json);
}
