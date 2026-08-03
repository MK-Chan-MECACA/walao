-- WALAO ticket 27: the operator boundary's one exception is the Account's to
-- grant (spec §106-107, §249). The Malay review queue returns Summary bodies;
-- until now it returned every Account's. Default false so the exception must be
-- asked for, and existing Accounts stay unreadable through the upgrade.

ALTER TABLE users ADD COLUMN IF NOT EXISTS quality_review_opt_in boolean NOT NULL DEFAULT false;
