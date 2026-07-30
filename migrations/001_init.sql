-- WALAO ticket 1: minimal chain for tenant-scoped, idempotent, encrypted ingestion.
-- Only the entities ticket 1 touches. Later tickets add retention/summaries/etc.
-- gen_random_uuid() is built into Postgres core (>=13); no pgcrypto extension needed.

CREATE TABLE IF NOT EXISTS users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_token_sha256 text NOT NULL UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS whatsapp_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  external_session_id text NOT NULL UNIQUE,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS groups (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   uuid NOT NULL REFERENCES whatsapp_sessions(id) ON DELETE CASCADE,
  external_jid text NOT NULL,
  name         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, external_jid)
);

CREATE TABLE IF NOT EXISTS messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id      uuid NOT NULL REFERENCES whatsapp_sessions(id) ON DELETE CASCADE,
  group_id        uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  external_id     text NOT NULL,
  sender_ref      text,
  sent_at         timestamptz NOT NULL,
  body_ciphertext bytea NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- idempotency on session + message id (README §13 threat: webhook replay)
  UNIQUE (session_id, external_id)
);

CREATE INDEX IF NOT EXISTS messages_user_id_idx ON messages (user_id);

-- Durable ingress queue: rows persist before processing, so a consumer restart
-- loses nothing (compensates for the gateway's lossy in-memory dispatcher).
CREATE TABLE IF NOT EXISTS ingest_events (
  id                  bigserial PRIMARY KEY,
  session_external_id text NOT NULL,
  external_id         text NOT NULL,
  payload             jsonb NOT NULL,
  status              text NOT NULL DEFAULT 'pending',
  created_at          timestamptz NOT NULL DEFAULT now(),
  processed_at        timestamptz,
  -- re-enqueue of the same event is a no-op (idempotent ingress)
  UNIQUE (session_external_id, external_id)
);

CREATE INDEX IF NOT EXISTS ingest_events_pending_idx
  ON ingest_events (id) WHERE status = 'pending';
