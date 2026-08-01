-- WALAO ticket 17: Processing Block (spec §27-31, §212-218).

-- Unpaid is operator-set: payment integration is out of scope, but the pipeline
-- must understand the state before a payment provider exists (spec §218).
ALTER TABLE users ADD COLUMN IF NOT EXISTS unpaid boolean NOT NULL DEFAULT false;

-- Over the group cap the N enabled longest keep processing (spec §240), so the
-- enable moment has to be a fact on the row. Existing enabled groups inherit
-- their registration time — the same order they were enabled in.
ALTER TABLE groups ADD COLUMN IF NOT EXISTS enabled_at timestamptz;
UPDATE groups SET enabled_at = created_at WHERE enabled AND enabled_at IS NULL;
