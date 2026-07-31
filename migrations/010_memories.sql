-- WALAO ticket 12: memory beta. A memories row exists only after explicit user
-- confirmation of a summary-proposed candidate — nothing becomes permanent by
-- model judgment alone. Content and source ids are copied at confirmation time
-- and summary_id is SET NULL on purge, so a confirmed memory outlives its
-- ~90-day source summary and persists until the user deletes it.

CREATE TABLE IF NOT EXISTS memories (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  summary_id         uuid REFERENCES summaries(id) ON DELETE SET NULL,
  item_index         int  NOT NULL CHECK (item_index >= 0),
  content            text NOT NULL,
  source_message_ids text[] NOT NULL DEFAULT '{}',
  group_jid          text,
  confirmed_by       uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz,
  UNIQUE (user_id, summary_id, item_index)
);

CREATE INDEX IF NOT EXISTS memories_user_id_idx ON memories (user_id);
