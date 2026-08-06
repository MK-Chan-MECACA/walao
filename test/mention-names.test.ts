import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, type Harness } from "./helpers.ts";
import { syncContacts } from "../src/subscriptions.ts";
import { loadSenderNames } from "../src/sender-names.ts";
import { buildTodayBrief } from "../src/brief.ts";
import { listSummaries } from "../src/surfaces.ts";

let h: Harness;

before(async () => {
  h = await makeHarness();
});
after(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.reset();
  h.gateway.contacts = {};
});

// A message row can only name people who post. Everyone else in a Group — the
// people the posters @mention — is named nowhere but the session's contact
// list, which is why the sync exists at all.
describe("mention and sender names", () => {
  it("names a mentioned person who has never posted, from the contact list", async () => {
    const userId = await h.seedUser("tok");
    const sessionId = await h.seedSession(userId, "sess-1");
    await h.pool.query(`UPDATE whatsapp_sessions SET status = 'connected' WHERE id = $1`, [
      sessionId,
    ]);
    const groupId = await h.seedGroup(sessionId, "aaa@g.us");
    await h.seedMessage(groupId, "m1", new Date().toISOString(), {
      text: "@40102864666870 confirmed 12/8",
    });

    h.gateway.contacts["sess-1"] = [
      { jid: "40102864666870@lid", name: "Yee Sheng" },
      { jid: "60127468708@s.whatsapp.net", name: "Ooi Zhi Wei" },
    ];
    assert.equal(await syncContacts(h.pool, h.gateway), 2);

    const names = await loadSenderNames(h.pool, userId);
    assert.equal(names.resolveMentions("@40102864666870 confirmed 12/8"), "@Yee Sheng confirmed 12/8");
    // A phone-addressed contact resolves off the same local part.
    assert.equal(names.resolveMentions("cc @60127468708"), "cc @Ooi Zhi Wei");
    // Nobody knows this one — it stays exactly as written rather than guessing.
    assert.equal(names.resolveMentions("@99999999999"), "@99999999999");
  });

  it("prefers the name someone posts under over the address book entry", async () => {
    const userId = await h.seedUser("tok");
    const sessionId = await h.seedSession(userId, "sess-1");
    await h.pool.query(`UPDATE whatsapp_sessions SET status = 'connected' WHERE id = $1`, [
      sessionId,
    ]);
    const groupId = await h.seedGroup(sessionId, "aaa@g.us");
    const msgId = await h.seedMessage(groupId, "m1", new Date().toISOString(), { text: "hi" });
    await h.pool.query(
      `UPDATE messages SET sender_ref = '30558843351102@lid', sender_name = 'Wei Ping' WHERE id = $1`,
      [msgId],
    );

    h.gateway.contacts["sess-1"] = [{ jid: "30558843351102@lid", name: "Old Nickname" }];
    await syncContacts(h.pool, h.gateway);

    const names = await loadSenderNames(h.pool, userId);
    assert.equal(names.nameFor("30558843351102@lid", null), "Wei Ping");
    assert.equal(names.resolveMentions("@30558843351102 tell her"), "@Wei Ping tell her");
  });

  // Summaries written before mention resolution existed keep the raw ids in
  // their item text, and the Brief reads them for a day and history for 90.
  it("names mentions inside a Summary written before the names were known", async () => {
    const userId = await h.seedUser("tok");
    const sessionId = await h.seedSession(userId, "sess-1");
    await h.pool.query(`UPDATE whatsapp_sessions SET status = 'connected' WHERE id = $1`, [
      sessionId,
    ]);
    const groupId = await h.seedGroup(sessionId, "aaa@g.us");
    await h.seedSummary(userId, groupId, {
      action_items: [
        {
          text: "@40102864666870 to set up n8n locally",
          source_message_ids: [],
          owner: null,
          due_at: null,
          confidence: 1,
        },
      ],
    });

    h.gateway.contacts["sess-1"] = [{ jid: "40102864666870@lid", name: "Yee Sheng" }];
    await syncContacts(h.pool, h.gateway);

    const brief = await buildTodayBrief(h.pool, userId);
    assert.equal(brief.needs_action[0]?.text, "@Yee Sheng to set up n8n locally");
    const history = await listSummaries(h.pool, userId);
    assert.equal(history[0].payload.action_items[0].text, "@Yee Sheng to set up n8n locally");
  });

  it("re-running the sync renames only what changed, and one Account's names never reach another", async () => {
    const userA = await h.seedUser("tok-a");
    const sessionA = await h.seedSession(userA, "sess-a");
    const userB = await h.seedUser("tok-b");
    const sessionB = await h.seedSession(userB, "sess-b");
    await h.pool.query(`UPDATE whatsapp_sessions SET status = 'connected'`);

    h.gateway.contacts["sess-a"] = [{ jid: "111222333@lid", name: "Ada" }];
    h.gateway.contacts["sess-b"] = [{ jid: "444555666@lid", name: "Bo" }];
    assert.equal(await syncContacts(h.pool, h.gateway), 2);
    // Nothing changed: the second pass writes nothing.
    assert.equal(await syncContacts(h.pool, h.gateway), 0);

    h.gateway.contacts["sess-a"] = [{ jid: "111222333@lid", name: "Ada Lovelace" }];
    assert.equal(await syncContacts(h.pool, h.gateway), 1);

    const a = await loadSenderNames(h.pool, userA);
    assert.equal(a.resolveMentions("@111222333 and @444555666"), "@Ada Lovelace and @444555666");
    const b = await loadSenderNames(h.pool, userB);
    assert.equal(b.resolveMentions("@111222333 and @444555666"), "@111222333 and @Bo");
  });
});
