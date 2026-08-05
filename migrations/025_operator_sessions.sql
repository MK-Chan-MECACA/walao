-- WALAO F3: a revocable Operator session.
-- The console used to hold the permanent operator secret as its cookie value,
-- so the credential was replayed on every request and DELETE /admin/session
-- could only ask the browser nicely to forget it. A session row is a thing that
-- can actually be revoked, and it expires on its own if nobody revokes it.
CREATE TABLE IF NOT EXISTS operator_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_sha256 text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '12 hours'
);

-- The purge on the retention timer scans by expiry.
CREATE INDEX IF NOT EXISTS operator_sessions_expires_at_idx ON operator_sessions (expires_at);
