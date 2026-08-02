-- WALAO ticket 20 (spec §13-14, §242-245, ADR-0001): idle Session eviction.
-- One process holds every Account's Session, so "no enabled Group and no login
-- for 14 days" needs a login timestamp to measure against. Stamped at verify,
-- which is the only place a credential is issued.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at timestamptz;
