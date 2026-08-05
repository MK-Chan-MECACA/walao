-- A Group belongs to the Account, but groups rows are keyed per Session
-- (001_init: UNIQUE (session_id, external_jid)) and re-pairing mints a new
-- Session. seedGroups then refills the new Session with every Group disabled,
-- so the Account's real choices stay behind on the Session it replaced:
-- consumer.ts resolves a Group by session_id, which means those Groups render
-- as enabled, still count against the Plan cap, and are read by nothing.
--
-- adoptGroups() in src/subscriptions.ts does this for every future re-pair.
-- This migration is the one-off repair for Sessions that were already replaced.
-- Idempotent (src/db.ts re-runs every migration on boot): each statement is a
-- no-op once the live rows already carry the state.
--
-- Nothing is deleted. messages and summaries hang off the old rows by
-- ON DELETE CASCADE, so dropping a superseded row would cost the Account its
-- history — the old rows are stood down, not removed.

-- The Session each Account is actually on: connected first, then most recent.
CREATE OR REPLACE VIEW live_sessions AS
  SELECT DISTINCT ON (s.user_id) s.user_id, s.id AS session_id
    FROM whatsapp_sessions s
   ORDER BY s.user_id, (s.status = 'connected') DESC, s.created_at DESC;

-- The state each Account last chose per Group, from every other Session.
CREATE OR REPLACE VIEW prior_group_state AS
  SELECT DISTINCT ON (l.user_id, g.external_jid)
         l.user_id, l.session_id AS live_session,
         g.id AS prior_id, g.external_jid, g.enabled, g.enabled_at
    FROM live_sessions l
    JOIN whatsapp_sessions s ON s.user_id = l.user_id AND s.id <> l.session_id
    JOIN groups g ON g.session_id = s.id
   ORDER BY l.user_id, g.external_jid,
            g.enabled DESC, g.enabled_at DESC NULLS LAST, g.created_at DESC;

-- 1. Carry each Account's choice onto the live Session's row.
UPDATE groups g
   SET enabled = true, enabled_at = p.enabled_at
  FROM prior_group_state p
 WHERE g.session_id = p.live_session
   AND g.external_jid = p.external_jid
   AND p.enabled AND NOT g.enabled;

-- 2. The schedule is a property of the Group, so it follows the Group.
INSERT INTO summary_schedules (group_id, local_time, timezone, language)
SELECT live.id, sc.local_time, sc.timezone, sc.language
  FROM prior_group_state p
  JOIN summary_schedules sc ON sc.group_id = p.prior_id
  JOIN groups live ON live.session_id = p.live_session
                  AND live.external_jid = p.external_jid
ON CONFLICT (group_id) DO NOTHING;

-- 3. Stand the superseded rows down. Only Groups the live Session actually
--    carries: one the gateway did not return keeps its state, so a Group is
--    never silently disabled because WhatsApp omitted it from a listing.
UPDATE groups g
   SET enabled = false
  FROM live_sessions l
 WHERE g.enabled
   AND g.session_id <> l.session_id
   AND g.session_id IN (SELECT id FROM whatsapp_sessions WHERE user_id = l.user_id)
   AND EXISTS (SELECT 1 FROM groups live
                WHERE live.session_id = l.session_id
                  AND live.external_jid = g.external_jid);

-- Scaffolding for this repair only — the app never reads these.
DROP VIEW IF EXISTS prior_group_state;
DROP VIEW IF EXISTS live_sessions;

