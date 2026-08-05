import type { IncomingMessage, ServerResponse } from "node:http";
import type pg from "pg";
import type { GatewayPort } from "./gateway/port.ts";
import type { Config } from "./config.ts";
import { ingestWebhook } from "./ingest.ts";
import { drainQueue } from "./consumer.ts";
import { authenticate, listMessages, summarySources } from "./api.ts";
import {
  DISCLOSURE_TEMPLATE,
  disableGroup,
  enableGroup,
  listGroups,
} from "./subscriptions.ts";
import { ATTESTATION_TEXTS, DATA_PROCESSING_TERMS, listAttestations } from "./attestations.ts";
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
import { isHalted, setHalted } from "./halt.ts";
import { getStatus } from "./block.ts";
import {
  getQualityReviewOptIn,
  recordReview,
  reviewQueue,
  setQualityReviewOptIn,
} from "./quality.ts";
import { cancelPlan, getUsage } from "./billing.ts";
import { accountMetadata, setPlan } from "./operator.ts";
import { login, logout, normalizeEmail, signup, verify, type SendCode } from "./accounts.ts";
import {
  EMAIL_CODE_PER_EMAIL,
  EMAIL_CODE_PER_IP,
  VERIFY_PER_EMAIL,
  VERIFY_PER_IP,
  allowBoth,
} from "./limits.ts";
import { resendSender } from "./mail.ts";
import { hashToken } from "./crypto.ts";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  sendCode?: SendCode;
}): App {
  const { pool, gateway, answerer, config } = deps;
  // Real mail when a Resend key is present, log line when it isn't, so the auth
  // flow stays runnable locally with no mail spend. Tests inject their own.
  const sendCode: SendCode =
    deps.sendCode ??
    (config.resendApiKey
      ? resendSender(config.resendApiKey, config.mailFrom)
      : async (email, code) => {
          console.log(`[walao] login code for ${email}: ${code}`);
        });

  // Hashed so the compare is over fixed-length inputs, constant-time so a wrong
  // secret leaks nothing about how wrong it was.
  const operatorOk = (given: string): boolean =>
    timingSafeEqual(
      Buffer.from(hashToken(given)),
      Buffer.from(hashToken(config.operatorSecret)),
    );

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void route(req, res).catch((err) => {
      console.error(err);
      send(res, 500, { error: "internal" });
    });
  };

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");

    // F6: the container's liveness probe. Deliberately says nothing — not the
    // database's state, not a version — so it stays safe to leave unauthenticated.
    if (req.method === "GET" && url.pathname === "/healthz") {
      send(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/webhooks/gateway") {
      // Halt switch (ticket 14): while halted the gateway ingress is refused
      // outright — nothing is parsed, verified, or written.
      if (await isHalted(pool)) {
        send(res, 503, null);
        return;
      }
      // An oversized body is refused before a signature is ever computed —
      // the HMAC would have to read all of it to say no (F4).
      const raw = await readRawBody(req).catch(() => null);
      if (raw === null) {
        send(res, 400, null);
        return;
      }
      // WAAPI Gateway signs as `X-Webhook-Signature: sha256=<hex>`; the native
      // header stays accepted so existing senders keep working. Both are the
      // same HMAC-SHA256 over the raw body, so only the encoding differs.
      const sig = (header(req, "x-webhook-signature") || header(req, "x-walao-signature")).replace(
        /^sha256=/,
        "",
      );
      const result = await ingestWebhook(pool, gateway, config, raw, sig);
      send(res, result.status, null);
      return;
    }

    // Everything under /admin is operator-only. Authorized by a dedicated
    // secret, compared constant-time via hashes — not by user bearer tokens.
    if (url.pathname.startsWith("/admin/")) {
      // Ticket 29 (app spec §54-55): the console trades the secret for an
      // httpOnly cookie once, so it never reaches page scripts or storage.
      // This route is the one /admin/* path reachable without the credential.
      if (url.pathname === "/admin/session") {
        if (req.method === "DELETE") {
          // F3: signing out ends the session server-side. Clearing the cookie
          // alone only asked the browser to forget a credential that still
          // worked — which is the whole reason the secret stopped being it.
          const token = cookie(req, "walao_op");
          if (token) {
            await pool.query(`DELETE FROM operator_sessions WHERE token_sha256 = $1`, [
              hashToken(token),
            ]);
          }
          setCookie(req, res, "walao_op", "");
          send(res, 200, { ok: true });
          return;
        }
        if (req.method === "POST") {
          const body = await readJsonBody(req);
          if (body === undefined) {
            send(res, 400, { error: "bad_json" });
            return;
          }
          const secret = (body as Record<string, unknown>).secret;
          if (typeof secret !== "string" || !operatorOk(secret)) {
            send(res, 401, { error: "unauthorized" });
            return;
          }
          // F3: the cookie carries a session token, not the secret itself — so
          // a leaked cookie is revocable, expires on its own, and is not the
          // permanent operator credential in transit on every request.
          const token = randomBytes(32).toString("hex");
          await pool.query(`INSERT INTO operator_sessions (token_sha256) VALUES ($1)`, [
            hashToken(token),
          ]);
          setCookie(req, res, "walao_op", token);
          send(res, 200, { ok: true });
          return;
        }
      }

      // The header path stays the constant-time secret compare (scripts and
      // curl still use it); the cookie path is a unique-indexed lookup of a
      // token that is worthless once revoked or expired.
      const opSecret = header(req, "x-walao-operator-secret");
      const opCookie = cookie(req, "walao_op");
      const authorized = opSecret
        ? operatorOk(opSecret)
        : opCookie !== null && (await operatorSessionOk(pool, opCookie));
      if (!authorized) {
        send(res, 401, { error: "unauthorized" });
        return;
      }

      // Halt switch (ticket 14). §58: the console shows the current state, so
      // the switch is readable without being flipped to find out.
      if (req.method === "GET" && url.pathname === "/admin/halt") {
        send(res, 200, { halted: await isHalted(pool) });
        return;
      }
      if (req.method === "POST" && (url.pathname === "/admin/halt" || url.pathname === "/admin/resume")) {
        const halted = url.pathname === "/admin/halt";
        await setHalted(pool, halted);
        send(res, 200, { halted });
        return;
      }

      // Quality operations (ticket 16, spec §54-55).
      if (req.method === "GET" && url.pathname === "/admin/review/queue") {
        send(res, 200, await reviewQueue(pool));
        return;
      }
      if (req.method === "POST" && url.pathname === "/admin/review") {
        const body = await readJsonBody(req);
        if (body === undefined) {
          send(res, 400, { error: "bad_json" });
          return;
        }
        const result = await recordReview(pool, body);
        if (result === "invalid") {
          send(res, 400, { error: "invalid_review" });
          return;
        }
        if (result === "not_found") {
          send(res, 404, { error: "not_found" });
          return;
        }
        send(res, 201, result);
        return;
      }

      // Operator console (ticket 28, spec §105, §109). Metadata only.
      const account = url.pathname.match(/^\/admin\/accounts\/([0-9a-f-]{36})$/);
      if (req.method === "GET" && account) {
        const meta = await accountMetadata(pool, account[1]);
        if (!meta) {
          send(res, 404, { error: "not_found" });
          return;
        }
        send(res, 200, meta);
        return;
      }

      const accountPlan = url.pathname.match(/^\/admin\/accounts\/([0-9a-f-]{36})\/plan$/);
      if (req.method === "PUT" && accountPlan) {
        const body = await readJsonBody(req);
        if (body === undefined) {
          send(res, 400, { error: "bad_json" });
          return;
        }
        const result = await setPlan(pool, accountPlan[1], (body as Record<string, unknown>).plan);
        if (result === "invalid") {
          send(res, 400, { error: "invalid_plan" });
          return;
        }
        if (result === "not_found") {
          send(res, 404, { error: "not_found" });
          return;
        }
        send(res, 200, { plan: result });
        return;
      }

      send(res, 404, { error: "not_found" });
      return;
    }

    // The terms are readable before an Account exists — signing up echoes this
    // version, so the wording has to be reachable without a credential (§6).
    if (req.method === "GET" && url.pathname === "/v1/terms") {
      send(res, 200, DATA_PROCESSING_TERMS);
      return;
    }

    // Account identity (ticket 18). These three are the only unauthenticated
    // /v1 write routes — they are how a caller gets a credential in the first place.
    if (
      req.method === "POST" &&
      (url.pathname === "/v1/signup" ||
        url.pathname === "/v1/login" ||
        url.pathname === "/v1/verify")
    ) {
      const body = await readJsonBody(req);
      if (body === undefined) {
        send(res, 400, { error: "bad_json" });
        return;
      }
      const b = body as Record<string, unknown>;
      // F4: counted per address and per source. Normalised first, so casing
      // cannot split one address across buckets. An address that does not parse
      // is not counted at all — it writes no row and sends no mail, so it costs
      // a regex, and spending a DB round trip to throttle a regex would be the
      // more expensive half of that trade.
      const ip = clientIp(req);
      const email = normalizeEmail(b.email);

      if (url.pathname === "/v1/verify") {
        // Over the limit answers exactly like a wrong code. A limiter that
        // announces itself is a limiter an attacker can calibrate against —
        // and here it would also leak that the address is worth attacking.
        if (email !== null && !(await allowBoth(pool, "verify", email, ip, VERIFY_PER_EMAIL, VERIFY_PER_IP))) {
          send(res, 400, { error: "invalid_code" });
          return;
        }
        const result = await verify(pool, b.email, b.code);
        if (result === "invalid") {
          send(res, 400, { error: "invalid_code" });
          return;
        }
        // The token is also handed to the browser as an httpOnly cookie (app
        // spec §3): the app never has to hold a credential page scripts can
        // read. The body still carries it, so API clients are unaffected.
        setCookie(req, res, "walao_session", result.token);
        send(res, 200, result);
        return;
      }

      // Both of these send a real email. Over the limit answers 202 — the same
      // envelope a genuine request gets — so throttling cannot be used to tell
      // a known address from an unknown one either (F4).
      if (
        email !== null &&
        !(await allowBoth(pool, "code", email, ip, EMAIL_CODE_PER_EMAIL, EMAIL_CODE_PER_IP))
      ) {
        send(res, 202, { ok: true });
        return;
      }

      const result =
        url.pathname === "/v1/signup"
          ? await signup(pool, sendCode, b.email, b.terms_version)
          : await login(pool, sendCode, b.email);
      if (result === "invalid") {
        send(res, 400, { error: "invalid_email" });
        return;
      }
      if (result === "terms_required") {
        send(res, 400, { error: "terms_required" });
        return;
      }
      // Always 202, known address or not: the answer must not reveal whether
      // an Account exists.
      send(res, 202, { ok: true });
      return;
    }

    // Everything else under /v1 is authenticated and tenant-scoped.
    if (url.pathname.startsWith("/v1/")) {
      // Header first, cookie second: every existing API client keeps working
      // and the browser gets in without one. SameSite=Lax plus JSON-only
      // mutating verbs is the CSRF posture — see the app spec's Further Notes.
      const userId = await authenticate(pool, bearer(req) ?? cookie(req, "walao_session"));
      if (!userId) {
        send(res, 401, { error: "unauthorized" });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/logout") {
        await logout(pool, userId);
        setCookie(req, res, "walao_session", "");
        send(res, 200, { ok: true });
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

      // The evidence behind one Summary — what makes "every claim carries a
      // source" checkable rather than asserted.
      const sources = url.pathname.match(/^\/v1\/summaries\/([0-9a-f-]{36})\/sources$/);
      if (req.method === "GET" && sources) {
        const result = await summarySources(pool, config, userId, sources[1]);
        if (!result) {
          send(res, 404, { error: "not_found" });
          return;
        }
        send(res, 200, { sources: result });
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
        if (result === "halted") {
          send(res, 503, { error: "halted" });
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

      // The single "is WALAO processing right now?" answer (ticket 17, spec §216).
      if (req.method === "GET" && url.pathname === "/v1/status") {
        send(res, 200, await getStatus(pool, userId));
        return;
      }

      // Cancellation (spec §100-101, §239): back to Free, nothing deleted.
      if (req.method === "POST" && url.pathname === "/v1/plan/cancel") {
        await cancelPlan(pool, userId);
        send(res, 200, { plan: "free" });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/usage") {
        send(res, 200, await getUsage(pool, userId));
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/attestations") {
        send(res, 200, { attestations: await listAttestations(pool, userId) });
        return;
      }

      // Ticket 21 (§21): every wording a client must show before echoing its
      // version, in one place. The group and Tier 1 affirmations had versions
      // with no text behind them until this route existed.
      if (req.method === "GET" && url.pathname === "/v1/attestation-texts") {
        send(res, 200, ATTESTATION_TEXTS);
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/disclosure-template") {
        send(res, 200, DISCLOSURE_TEMPLATE);
        return;
      }

      // Ticket 27 (§107): opting Operators in to reading this Account's
      // Summaries for quality review, and opting back out.
      if (url.pathname === "/v1/quality-review") {
        if (req.method === "GET") {
          send(res, 200, { opt_in: await getQualityReviewOptIn(pool, userId) });
          return;
        }
        if (req.method === "PUT") {
          let body: unknown = {};
          try {
            body = JSON.parse((await readRawBody(req)).toString("utf8") || "{}");
          } catch {
            send(res, 400, { error: "bad_json" });
            return;
          }
          const result = await setQualityReviewOptIn(
            pool,
            userId,
            (body as Record<string, unknown>).opt_in,
          );
          if (result === "invalid") {
            send(res, 400, { error: "invalid_opt_in" });
            return;
          }
          send(res, 200, { opt_in: result });
          return;
        }
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
        // Halt state rides the connection-health surface so users see an honest
        // status instead of a silently dead gateway.
        send(res, 200, {
          connections: await listConnections(pool, userId),
          halted: await isHalted(pool),
        });
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
        if (result === "halted") {
          send(res, 503, { error: "halted" });
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
        if (result === "plan_limit") {
          send(res, 403, { error: "plan_limit" });
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

    // The app itself, served same-origin from public/. Last branch, so it can
    // never shadow an API route.
    if ((req.method === "GET" || req.method === "HEAD") && (await serveStatic(res, url.pathname))) {
      return;
    }

    send(res, 404, { error: "not_found" });
  }

  return { handler, drain: () => drainQueue(pool, gateway, config) };
}

// Resolved (so no trailing separator) — the F5 guard below appends its own and
// would otherwise compare against a doubled slash that matches nothing.
const PUBLIC_DIR = path.resolve(fileURLToPath(new URL("../public/", import.meta.url)));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
};

// F1. Strict because it can be: after the inline page scripts moved into
// public/*.js and the QR library was vendored, the app loads nothing it does
// not serve itself, so 'self' needs no escape hatch and an injected <script>
// has nowhere to come from. `data:` on img-src is the QR code, which is a data
// URL by construction.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

// Every response, not only the HTML ones: a JSON error page is still a document
// a browser can be tricked into rendering. HSTS is unconditional — browsers
// ignore it over plain HTTP, so dev on localhost is unaffected and nothing has
// to know whether it is deployed.
function securityHeaders(res: ServerResponse): void {
  res.setHeader("content-security-policy", CSP);
  res.setHeader("strict-transport-security", "max-age=15552000; includeSubDomains");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
}

// Static branch: `/` is the shell, an extensionless path is that page's .html,
// anything else is served as itself. The resolve-then-prefix check is the
// traversal guard and is deliberately not simplified away — a path that escapes
// public/ is a 404, never a file read. Returns false to fall through to 404.
async function serveStatic(res: ServerResponse, pathname: string): Promise<boolean> {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return false; // malformed percent-encoding is not a path
  }
  if (rel.includes("\0")) return false;
  if (rel.endsWith("/")) rel += "index.html";
  else if (!path.extname(rel)) rel += ".html";

  const file = path.resolve(PUBLIC_DIR, "." + rel);
  // F5: prefix alone is not containment — a sibling directory named `public-x`
  // shares the prefix and would be served. The separator is the boundary.
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return false;

  let body: Buffer;
  try {
    body = await readFile(file);
  } catch {
    return false; // missing, or a directory — both are 404
  }
  securityHeaders(res);
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  res.end(body);
  return true;
}

// F3: a live Operator session, or nothing. Expiry is in the same query as the
// lookup, so an expired session is indistinguishable from a revoked one.
async function operatorSessionOk(pool: pg.Pool, token: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM operator_sessions WHERE token_sha256 = $1 AND expires_at > now()`,
    [hashToken(token)],
  );
  return rows.length > 0;
}

// undefined = malformed JSON (caller sends 400). Empty body parses as {}.
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  try {
    return JSON.parse((await readRawBody(req)).toString("utf8") || "{}");
  } catch {
    return undefined;
  }
}

// F4: no request this app accepts is close to a megabyte — the largest is one
// WhatsApp event — so anything past it is either a mistake or an attempt to make
// the process hold arbitrary memory. Over the cap the promise rejects and
// nothing further is buffered; the socket is drained rather than destroyed so
// the caller still gets its 400 back.
const MAX_BODY_BYTES = 1_000_000;

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c) => {
      if (over) return;
      size += (c as Buffer).length;
      if (size > MAX_BODY_BYTES) {
        over = true;
        chunks.length = 0;
        reject(new Error("body_too_large"));
        return;
      }
      chunks.push(c as Buffer);
    });
    req.on("end", () => {
      if (!over) resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

function header(req: IncomingMessage, name: string): string {
  const v = req.headers[name];
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

// F4: behind a proxy every request arrives from the proxy's address, which
// would quietly turn the per-source limit into one global limit. The *last*
// X-Forwarded-For entry is the one the nearest trusted proxy appended, so a
// client that forges the header only lengthens a list it does not get to end.
// With no proxy in front there is no header and the socket address is the truth.
function clientIp(req: IncomingMessage): string {
  const forwarded = header(req, "x-forwarded-for").split(",");
  const nearest = forwarded[forwarded.length - 1].trim();
  return nearest || req.socket.remoteAddress || "unknown";
}

function bearer(req: IncomingMessage): string | null {
  const auth = header(req, "authorization");
  const m = auth.match(/^Bearer (.+)$/);
  return m ? m[1] : null;
}

function cookie(req: IncomingMessage, name: string): string | null {
  for (const part of header(req, "cookie").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

// httpOnly so page scripts cannot read the credential, SameSite=Lax so no
// cross-site request carries it. Secure everywhere except a localhost Host:
// dev over plain HTTP works, anything deployed gets the flag, and there is no
// env var to misconfigure into a cookie the browser silently refuses to send.
// An empty value clears the cookie.
function setCookie(req: IncomingMessage, res: ServerResponse, name: string, value: string): void {
  const host = header(req, "host").split(":")[0];
  const secure = host === "localhost" || host === "127.0.0.1" ? "" : "; Secure";
  const expiry = value === "" ? "; Max-Age=0" : "";
  res.setHeader("set-cookie", `${name}=${value}; HttpOnly; SameSite=Lax; Path=/${secure}${expiry}`);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  securityHeaders(res);
  if (body === null) {
    res.writeHead(status);
    res.end();
    return;
  }
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(json);
}
