import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, type Harness } from "./helpers.ts";
import { accountKey } from "../src/accounts.ts";
import { decrypt } from "../src/crypto.ts";

// Ticket 24 (spec §71-72, §305, ADR-0002): a body belongs to one Account's key,
// and deleting the Account destroys the key. Both assertions land on stored
// ciphertext, because that is what survives into a backup nobody can rewrite.

let h: Harness;

before(async () => {
  h = await makeHarness();
});
after(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.reset();
});

async function seedBody(token: string, text: string): Promise<string> {
  const userId = await h.seedUser(token);
  const sessionId = await h.seedSession(userId, `sess-${token}`);
  const groupId = await h.seedGroup(sessionId, `${token}@g.us`);
  await h.seedMessage(groupId, `msg-${token}`, new Date().toISOString(), { text });
  return userId;
}

async function ciphertext(userId: string): Promise<Buffer | null> {
  const { rows } = await h.pool.query(
    `SELECT body_ciphertext FROM messages WHERE user_id = $1`,
    [userId],
  );
  return rows.length ? rows[0].body_ciphertext : null;
}

describe("per-account envelope encryption", () => {
  it("a body encrypts under its own Account's key and under no other's", async () => {
    const a = await seedBody("enc-a", "alpha secret");
    const b = await seedBody("enc-b", "beta secret");

    const keyA = await accountKey(h.pool, h.config, a);
    const keyB = await accountKey(h.pool, h.config, b);
    assert.notDeepEqual(keyA, keyB);
    assert.notDeepEqual(keyA, h.config.encKey); // never the master key

    const blobA = (await ciphertext(a)) as Buffer;
    assert.equal(decrypt(blobA, keyA), "alpha secret");
    assert.throws(() => decrypt(blobA, keyB));
    assert.throws(() => decrypt(blobA, h.config.encKey));
  });

  it("deleting an Account destroys its key, so a leftover body stays unreadable", async () => {
    const a = await seedBody("enc-shred", "shred me");
    const blob = (await ciphertext(a)) as Buffer;

    // What a backup would still hold after the delete: the row, not the key.
    const res = await h.api("enc-shred", "DELETE", "/v1/account");
    assert.equal(res.status, 200);

    assert.equal(await ciphertext(a), null); // primary storage is emptied too
    const { rows } = await h.pool.query(`SELECT data_key_wrapped FROM users WHERE id = $1`, [a]);
    assert.equal(rows.length, 0);
    // The key cannot be re-derived, so the surviving copy of the body is noise
    // to every key the system still holds.
    assert.throws(() => decrypt(blob, h.config.encKey));
  });
});
