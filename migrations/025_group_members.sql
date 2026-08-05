-- WhatsApp Communities give two chats the same display name: the announcement
-- group (a handful of members) and the Group itself (hundreds). On the Groups
-- screen those render as two identical rows, and nothing on screen says which
-- one to enable — the gateway sends a member count on every listing and we were
-- dropping it (waapi.ts listGroups kept only jid and name).
--
-- Nullable: a row discovered from a message rather than a listing has no count
-- until the next backfill pass fills it, and the UI simply omits it.
ALTER TABLE groups ADD COLUMN IF NOT EXISTS members int;
