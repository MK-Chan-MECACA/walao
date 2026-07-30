import {
  createHmac,
  timingSafeEqual,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHash,
} from "node:crypto";

// HMAC-SHA256 over the raw request body, constant-time compared against the
// signature the gateway sent. Returns false on any malformed input rather than
// throwing — a forged event must be a quiet rejection.
export function verifyHmac(rawBody: Buffer, signatureHex: string, secret: string): boolean {
  if (!signatureHex) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  let given: Buffer;
  try {
    given = Buffer.from(signatureHex, "hex");
  } catch {
    return false;
  }
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

// Sign a body the way the gateway would — used by tests and any adapter helper.
export function signHmac(rawBody: Buffer, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

// AES-256-GCM. Layout: [12-byte iv][16-byte auth tag][ciphertext]. Self-contained
// so decrypt needs only the key.
export function encrypt(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

export function decrypt(blob: Buffer, key: Buffer): string {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

// Bearer tokens are stored only as their SHA-256 hash.
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
