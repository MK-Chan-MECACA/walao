-- WALAO ticket 10: privacy controls. paused halts the whole pipeline; the
-- audit table proves every privacy action (actor/action/timestamp only, never
-- message content). user_id has NO foreign key on purpose: the delete_account
-- event must outlive the account it records.

ALTER TABLE users ADD COLUMN IF NOT EXISTS paused boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS privacy_audit (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL,
  action     text NOT NULL CHECK (action IN ('pause', 'resume', 'export', 'delete_group', 'delete_account')),
  -- delete_group stores the group jid so the event is attributable; never bodies.
  detail     text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS privacy_audit_user_idx ON privacy_audit (user_id, created_at);
