import type { IncomingMessage, ServerResponse } from "node:http";
import type pg from "pg";
import type { GatewayPort } from "./gateway/port.ts";
import type { Config } from "./config.ts";
import { ingestWebhook } from "./ingest.ts";
import { drainQueue } from "./consumer.ts";
import { authenticate, listMessages } from "./api.ts";
import {
  DISCLOSURE_TEMPLATE,
  disableGroup,
  enableGroup,
  listConsentRecords,
  listGroups,
} from "./subscriptions.ts";
import {
  ONBOARDING_DISCLOSURE,
  createConnection,
  disconnectConnection,
  listConnections,
} from "./connections.ts";
import { getRetentionDays, setRetentionDays } from "./retention.ts";
import { setSchedule } from "./scheduler.ts";
import { buildTodayBrief } from "./brief.ts";
import {
  confirmActionItem,
  listReminders,
  listSummaries,
  setItemState,
  updateReminder,
} from "./surfaces.ts";
import { deleteAccount, deleteGroupData, exportData, setPaused } from "./privacy.ts";
import {
  buildWeeklyReview,
  confirmCandidate,
  deleteMemory,
  listCandidates,
  listMemories,
  updateMemory,
} from "./memory.ts";
import { askQuestion, type AnswererPort } from "./ask.ts";
import { enableTier1, sendOutbound } from "./tier1.ts";

export type App = {
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  drain: () => Promise<number>;
};

// Compose the system with an injectable GatewayPort — the whole-system test seam
// swaps in a fake gateway while everything else (ingress security, queue, store,
// API) runs for real against real Postgres.
export function createApp(deps: {
  pool: pg.Pool;
  gateway: GatewayPort;
  answerer: AnswererPort;
  config: Config;
}): App {
  const { pool, gateway, answerer, config } = deps;

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

    // Everything under /v1 is authenticated and tenant-scoped.
    if (url.pathname.startsWith("/v1/")) {
      const userId = await authenticate(pool, bearer(req));
      if (!userId) {
        send(res, 401, { error: "unauthorized" });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/messages") {
        send(res, 200, { messages: await listMessages(pool, config, userId) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/briefs/today") {
        send(res, 200, await buildTodayBrief(pool, userId));
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/summaries") {
        send(res, 200, { summaries: await listSummaries(pool, userId) });
        return;
      }

      const itemState = url.pathname.match(
        /^\/v1\/summaries\/([0-9a-f-]{36})\/items\/([a-z_]+)\/(\d{1,4})\/state$/,
      );
      if (req.method === "PUT" && itemState) {
        const body = await readJsonBody(req);
        if (body === undefined) {
          send(res, 400, { error: "bad_json" });
          return;
        }
        const state = (body as Record<string, unknown>).state ?? null;
        const result = await setItemState(
          pool,
          userId,
          itemState[1],
          itemState[2],
          Number(itemState[3]),
          state,
        );
        if (result === "not_found") {
          send(res, 404, { error: "not_found" });
          return;
        }
        if (result === "invalid") {
          send(res, 400, { error: "invalid_item_state" });
          return;
        }
        send(res, 200, { ok: true });
        return;
      }

      const confirm = url.pathname.match(
        /^\/v1\/summaries\/([0-9a-f-]{36})\/action-items\/(\d{1,4})\/confirm$/,
      );
      if (req.method === "POST" && confirm) {
        const body = await readJsonBody(req);
        if (body === undefined) {
          send(res, 400, { error: "bad_json" });
          return;
        }
        const result = await confirmActionItem(pool, userId, confirm[1], Number(confirm[2]), body);
        if (result === "not_found") {
          send(res, 404, { error: "not_found" });
          return;
        }
        if (result === "invalid") {
          send(res, 400, { error: "invalid_action_item" });
          return;
        }
        send(res, 201, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/ask") {
        const body = await readJsonBody(req);
        if (body === undefined) {
          send(res, 400, { error: "bad_json" });
          return;
        }
        const result = await askQuestion(
          pool,
          answerer,
          config,
          userId,
          (body as Record<string, unknown>).question,
        );
        if (result === "invalid") {
          send(res, 400, { error: "invalid_question" });
          return;
        }
        send(res, 200, result);
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/memories/candidates") {
        send(res, 200, { candidates: await listCandidates(pool, userId) });
        return;
      }

      const memConfirm = url.pathname.match(
        /^\/v1\/summaries\/([0-9a-f-]{36})\/memory-candidates\/(\d{1,4})\/confirm$/,
      );
      if (req.method === "POST" && memConfirm) {
        const result = await confirmCandidate(pool, userId, memConfirm[1], Number(memConfirm[2]));
        if (result === "not_found") {
          send(res, 404, { error: "not_found" });
          return;
        }
        if (result === "invalid" || result === "expired") {
          send(res, 400, { error: result === "expired" ? "candidate_expired" : "invalid_candidate" });
          return;
        }
        send(res, 201, result);
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/memories") {
        send(res, 200, { memories: await listMemories(pool, userId) });
        return;
      }

      const memory = url.pathname.match(/^\/v1\/memories\/([0-9a-f-]{36})$/);
      if (req.method === "PUT" && memory) {
        const body = await readJsonBody(req);
        if (body === undefined) {
          send(res, 400, { error: "bad_json" });
          return;
        }
        const result = await updateMemory(pool, userId, memory[1], body);
        if (result === "not_found") {
          send(res, 404, { error: "not_found" });
          return;
        }
        if (result === "invalid") {
          send(res, 400, { error: "invalid_memory" });
          return;
        }
        send(res, 200, result);
        return;
      }
      if (req.method === "DELETE" && memory) {
        const result = await deleteMemory(pool, userId, memory[1]);
        send(res, result === "ok" ? 200 : 404, result === "ok" ? { ok: true } : { error: "not_found" });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/review/weekly") {
        send(res, 200, await buildWeeklyReview(pool, userId));
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/reminders") {
        send(res, 200, { reminders: await listReminders(pool, userId) });
        return;
      }

      const reminder = url.pathname.match(/^\/v1\/reminders\/([0-9a-f-]{36})$/);
      if (req.method === "PUT" && reminder) {
        const body = await readJsonBody(req);
        if (body === undefined) {
          send(res, 400, { error: "bad_json" });
          return;
        }
        const result = await updateReminder(pool, userId, reminder[1], body);
        if (result === "not_found") {
          send(res, 404, { error: "not_found" });
          return;
        }
        if (result === "invalid") {
          send(res, 400, { error: "invalid_reminder" });
          return;
        }
        send(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/tier1") {
        const body = await readJsonBody(req);
        if (body === undefined) {
          send(res, 400, { error: "bad_json" });
          return;
        }
        const result = await enableTier1(
          pool,
          userId,
          (body as Record<string, unknown>).authorization_version,
        );
        if (result === "authorization_required") {
          send(res, 400, { error: "authorization_required" });
          return;
        }
        send(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/outbound") {
        const body = await readJsonBody(req);
        if (body === undefined) {
          send(res, 400, { error: "bad_json" });
          return;
        }
        const b = body as Record<string, unknown>;
        const result = await sendOutbound(pool, gateway, userId, b.recipient, b.text);
        if (result === "invalid") {
          send(res, 400, { error: "invalid_outbound" });
          return;
        }
        if (result === "tier1_required") {
          send(res, 403, { error: "tier1_required" });
          return;
        }
        if (typeof result === "string") {
          send(res, 409, { error: result }); // paused | not_connected | handshake_pending
          return;
        }
        send(res, 201, result);
        return;
      }

      if (req.method === "POST" && (url.pathname === "/v1/pause" || url.pathname === "/v1/resume")) {
        const paused = url.pathname === "/v1/pause";
        await setPaused(pool, userId, paused);
        send(res, 200, { paused });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/export") {
        send(res, 200, await exportData(pool, config, userId));
        return;
      }

      if (req.method === "DELETE" && url.pathname === "/v1/account") {
        await deleteAccount(pool, userId);
        send(res, 200, { ok: true });
        return;
      }

      const delGroup = url.pathname.match(/^\/v1\/groups\/([0-9a-f-]{36})$/);
      if (req.method === "DELETE" && delGroup) {
        const result = await deleteGroupData(pool, gateway, userId, delGroup[1]);
        if (result === "not_found") {
          send(res, 404, { error: "not_found" });
          return;
        }
        send(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/groups") {
        send(res, 200, { groups: await listGroups(pool, userId) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/consent-records") {
        send(res, 200, { records: await listConsentRecords(pool, userId) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/disclosure-template") {
        send(res, 200, DISCLOSURE_TEMPLATE);
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/retention") {
        send(res, 200, { retention_days: await getRetentionDays(pool, userId) });
        return;
      }

      if (req.method === "PUT" && url.pathname === "/v1/retention") {
        let body: unknown = {};
        try {
          body = JSON.parse((await readRawBody(req)).toString("utf8") || "{}");
        } catch {
          send(res, 400, { error: "bad_json" });
          return;
        }
        const days = (body as Record<string, unknown>).retention_days;
        const result = await setRetentionDays(pool, userId, days);
        if (result === "invalid") {
          send(res, 400, { error: "invalid_retention_days" });
          return;
        }
        send(res, 200, { retention_days: result });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/onboarding") {
        send(res, 200, ONBOARDING_DISCLOSURE);
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/connections") {
        send(res, 200, { connections: await listConnections(pool, userId) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/connections") {
        let body: unknown = {};
        try {
          body = JSON.parse((await readRawBody(req)).toString("utf8") || "{}");
        } catch {
          send(res, 400, { error: "bad_json" });
          return;
        }
        const version = (body as Record<string, unknown>).disclosure_version;
        const result = await createConnection(pool, gateway, userId, version);
        if (result === "disclosure_required") {
          send(res, 400, { error: "disclosure_required" });
          return;
        }
        send(res, 201, result);
        return;
      }

      const disconnect = url.pathname.match(/^\/v1\/connections\/([0-9a-f-]{36})\/disconnect$/);
      if (req.method === "POST" && disconnect) {
        const result = await disconnectConnection(pool, userId, disconnect[1]);
        if (result === "not_found") {
          send(res, 404, { error: "not_found" });
          return;
        }
        send(res, 200, { ok: true });
        return;
      }

      const sched = url.pathname.match(/^\/v1\/groups\/([0-9a-f-]{36})\/schedule$/);
      if (req.method === "PUT" && sched) {
        let body: unknown = {};
        try {
          body = JSON.parse((await readRawBody(req)).toString("utf8") || "{}");
        } catch {
          send(res, 400, { error: "bad_json" });
          return;
        }
        const result = await setSchedule(pool, userId, sched[1], body);
        if (result === "not_found") {
          send(res, 404, { error: "not_found" });
          return;
        }
        if (result === "not_enabled" || result === "invalid") {
          send(res, 400, { error: result === "invalid" ? "invalid_schedule" : "not_enabled" });
          return;
        }
        send(res, 200, result);
        return;
      }

      const toggle = url.pathname.match(/^\/v1\/groups\/([0-9a-f-]{36})\/(enable|disable)$/);
      if (req.method === "POST" && toggle) {
        const [, groupId, action] = toggle;
        let result;
        if (action === "enable") {
          let body: unknown = {};
          try {
            body = JSON.parse((await readRawBody(req)).toString("utf8") || "{}");
          } catch {
            send(res, 400, { error: "bad_json" });
            return;
          }
          const version = (body as Record<string, unknown>).attestation_version;
          result = await enableGroup(pool, userId, groupId, version);
        } else {
          result = await disableGroup(pool, userId, groupId);
        }
        if (result === "attestation_required") {
          send(res, 400, { error: "attestation_required" });
          return;
        }
        if (result === "not_found") {
          send(res, 404, { error: "not_found" });
          return;
        }
        send(res, 200, { ok: true });
        return;
      }
    }

    send(res, 404, { error: "not_found" });
  }

  return { handler, drain: () => drainQueue(pool, gateway, config) };
}

// undefined = malformed JSON (caller sends 400). Empty body parses as {}.
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  try {
    return JSON.parse((await readRawBody(req)).toString("utf8") || "{}");
  } catch {
    return undefined;
  }
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
