-- WALAO ticket 2: per-group subscriptions (all off by default) + consent audit.
-- README §10 names this table consent_records.

ALTER TABLE groups ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS consent_records (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id            uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  action              text NOT NULL CHECK (action IN ('enabled', 'disabled')),
  -- enabling requires a self-attestation; disabling needs none
  attestation_version text CHECK (action = 'disabled' OR attestation_version IS NOT NULL),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS consent_records_user_idx
  ON consent_records (user_id, created_at);
