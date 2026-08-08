-- Ticket 08: the queue of @mentions waiting to be judged. One row per stored
-- message that named the Account holder, written where the plaintext is already
-- in hand (the consumer) — anywhere later would mean decrypting a second time to
-- answer a question that was answerable for free.
--
-- The primary key IS the message, so a replayed webhook cannot queue the same
-- mention twice. The cascade is the whole retention story: a queued ping is a
-- pointer at a raw message, and it leaves when that message expires — there is
-- no second sweep to write and none to forget.
--
-- resolved_at closes the row for every outcome alike — pinged, judged as
-- needing nothing, or past the hourly ceiling — because the only thing the tick
-- has to know is "never look at this again". Which outcome it was is already in
-- the chat or deliberately not.
CREATE TABLE IF NOT EXISTS mention_pings (
  message_id  uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS mention_pings_pending_idx
  ON mention_pings (created_at) WHERE resolved_at IS NULL;
