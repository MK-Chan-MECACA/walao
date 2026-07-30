-- WALAO ticket 4: raw retention & expiry. One global per-user window (1-30
-- days, default 7); every raw message carries an expiry stamped at store time.

ALTER TABLE users ADD COLUMN IF NOT EXISTS retention_days int NOT NULL DEFAULT 7
  CHECK (retention_days BETWEEN 1 AND 30);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS expires_at timestamptz;
-- Rows stored before this migration get the default window from their store time.
UPDATE messages SET expires_at = created_at + interval '7 days' WHERE expires_at IS NULL;
ALTER TABLE messages ALTER COLUMN expires_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS messages_expires_at_idx ON messages (expires_at);
