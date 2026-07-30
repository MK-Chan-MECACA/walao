-- WALAO ticket 3: connection lifecycle — health state + incomplete-coverage markers.

-- Default 'connected' grandfathers pre-ticket-3 rows; pairing inserts 'pending'.
ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'connected';
ALTER TABLE whatsapp_sessions ADD COLUMN IF NOT EXISTS status_changed_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE whatsapp_sessions DROP CONSTRAINT IF EXISTS whatsapp_sessions_status_check;
ALTER TABLE whatsapp_sessions ADD CONSTRAINT whatsapp_sessions_status_check
  CHECK (status IN ('pending', 'connected', 'disconnected', 're_pair_required'));

-- One open gap (ended_at IS NULL) per session at a time. Later tickets flag any
-- summary window that overlaps a gap as incomplete instead of silently truncating.
CREATE TABLE IF NOT EXISTS coverage_gaps (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES whatsapp_sessions(id) ON DELETE CASCADE,
  reason     text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at   timestamptz
);

CREATE INDEX IF NOT EXISTS coverage_gaps_open_idx
  ON coverage_gaps (session_id) WHERE ended_at IS NULL;
