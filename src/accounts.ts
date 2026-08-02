import { randomInt, randomBytes, timingSafeEqual } from "node:crypto";
import type pg from "pg";
import { decrypt, encrypt, hashToken } from "./crypto.ts";
import type { Config } from "./config.ts";
import { DATA_PROCESSING_TERMS, recordAttestation } from "./attestations.ts";

// Ticket 18 (spec §1-3, §199-203): an Account is an email address that proved
// it can receive mail. No password — the mail round trip is the factor.

// Delivering the code is the one thing this module cannot do itself.
export type SendCode = (email: string, code: string) => Promise<void>;

const CODE_TTL_MS = 15 * 60_000;
// 31 unambiguous characters, 8 of them: ~40 bits. Enough that online guessing
// inside the 15-minute window is not a threat, so no attempt counter is needed.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

// Normalised at the boundary so "A@b.com" and "a@b.com" are one Account.
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

function newCode(): string {
  let code = "";
  for (let i = 0; i < 8; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

// Signup and login are the same act once the Account exists, so they share the
// code issue. Both answer identically whether or not the address is known —
// the API must not become an account-existence oracle.
export async function signup(
  pool: pg.Pool,
  send: SendCode,
  rawEmail: unknown,
  termsVersion?: unknown,
): Promise<"invalid" | "terms_required" | "ok"> {
  const email = normalizeEmail(rawEmail);
  if (!email) return "invalid";
  // Ticket 19 (spec §6): signing up affirms the data-processing terms, and the
  // version echoed here is the version stored — proof the wording was shown.
  if (termsVersion !== DATA_PROCESSING_TERMS.version) return "terms_required";
  const { rows } = await pool.query(
    `INSERT INTO users (email) VALUES ($1)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id`,
    [email],
  );
  await recordAttestation(pool, rows[0].id, "data_processing_terms");
  await issueCode(pool, send, rows[0].id, email);
  return "ok";
}

export async function login(
  pool: pg.Pool,
  send: SendCode,
  rawEmail: unknown,
): Promise<"invalid" | "ok"> {
  const email = normalizeEmail(rawEmail);
  if (!email) return "invalid";
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
  if (rows.length) await issueCode(pool, send, rows[0].id, email);
  return "ok";
}

async function issueCode(
  pool: pg.Pool,
  send: SendCode,
  userId: string,
  email: string,
): Promise<void> {
  const code = newCode();
  await pool.query(
    `UPDATE users SET login_code_sha256 = $2, login_code_expires_at = now() + $3::interval
     WHERE id = $1`,
    [userId, hashToken(code), `${CODE_TTL_MS} milliseconds`],
  );
  await send(email, code);
}

// Verifying consumes the code, marks the address verified and rotates the
// bearer token. It is the only place a token is minted.
export async function verify(
  pool: pg.Pool,
  rawEmail: unknown,
  rawCode: unknown,
): Promise<"invalid" | { token: string; user_id: string }> {
  const email = normalizeEmail(rawEmail);
  if (!email || typeof rawCode !== "string") return "invalid";
  const { rows } = await pool.query(
    `SELECT id, login_code_sha256 FROM users
     WHERE email = $1 AND login_code_sha256 IS NOT NULL AND login_code_expires_at > now()`,
    [email],
  );
  if (!rows.length) return "invalid";
  const given = Buffer.from(hashToken(rawCode.trim().toUpperCase()));
  const expected = Buffer.from(rows[0].login_code_sha256);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return "invalid";

  const token = randomBytes(32).toString("hex");
  await pool.query(
    `UPDATE users
     SET api_token_sha256 = $2,
         email_verified_at = COALESCE(email_verified_at, now()),
         last_login_at = now(),
         login_code_sha256 = NULL,
         login_code_expires_at = NULL
     WHERE id = $1`,
    [rows[0].id, hashToken(token)],
  );
  return { token, user_id: rows[0].id };
}

// Ticket 24 (spec §71-72, §220-227, ADR-0002): message bodies belong to one
// Account's key, not to the master key, so deleting the Account makes its rows
// undecryptable everywhere they still exist — including a backup nobody can
// rewrite. The key is minted on first use rather than at signup: every path
// that creates a users row (signup, operator, seeds) then gets one without
// having to know this exists. COALESCE under the row lock makes the mint
// race-safe — a concurrent minter waits, re-reads and keeps the stored key.
const keyCache = new Map<string, Buffer>();

export async function accountKey(
  db: pg.Pool | pg.PoolClient,
  config: Config,
  userId: string,
): Promise<Buffer> {
  const cached = keyCache.get(userId);
  if (cached) return cached;
  const { rows } = await db.query(
    `UPDATE users SET data_key_wrapped = COALESCE(data_key_wrapped, $2)
     WHERE id = $1 RETURNING data_key_wrapped`,
    [userId, encrypt(randomBytes(32).toString("base64"), config.encKey)],
  );
  if (!rows.length) throw new Error(`no such account: ${userId}`);
  const key = Buffer.from(decrypt(rows[0].data_key_wrapped, config.encKey), "base64");
  keyCache.set(userId, key);
  return key;
}

// Crypto-shredding only holds if the process stops holding the key too.
// ponytail: unbounded process-wide cache, one 32-byte key per active Account;
// give it a TTL if a single process ever serves more Accounts than fit in RAM.
export function forgetAccountKey(userId: string): void {
  keyCache.delete(userId);
}
