-- WALAO ticket 7: note-to-self delivery (Tier 0). NULL = not yet delivered;
-- the delivery drain claims undelivered rows and stamps this on success.

ALTER TABLE summaries ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
