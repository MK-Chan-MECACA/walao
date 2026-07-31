-- WALAO ticket 15: pricing & usage (spec §51-53). Plan lives on the user; credit
-- burn is derived from summaries rows (1 credit = 1 AI-generated group summary),
-- so no ledger table — deletion of a group's data deletes its billing trail too.
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'free';
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_plan_check;
ALTER TABLE users ADD CONSTRAINT users_plan_check CHECK (plan IN ('free', 'pro'));
