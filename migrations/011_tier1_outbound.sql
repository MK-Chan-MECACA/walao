-- WALAO ticket 13: Tier 1 opt-in outbound + recipient "Yes" handshake.
-- Tier 0 stays the default: these columns/rows exist only for users who
-- explicitly authorized outbound to others (spec §47) and only for numbers
-- they actually messaged (spec §48).

ALTER TABLE users ADD COLUMN IF NOT EXISTS tier1_authorization_version text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS tier1_enabled_at timestamptz;

CREATE TABLE IF NOT EXISTS outbound_recipients (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_jid text NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  confirmed_at  timestamptz,
  -- one handshake per user × number; also the ingress lookup key
  UNIQUE (user_id, recipient_jid)
);
