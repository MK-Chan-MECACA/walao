-- WALAO ticket 18: Account identity (spec §1-3, §199-203).
-- An Account is created by email and is usable before any WhatsApp Session.

-- ponytail: lowercased text + UNIQUE instead of the spec's citext — same
-- "one Account per address" effect with no CREATE EXTENSION privilege at
-- deploy time. Normalisation happens at the boundary in src/accounts.ts.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email text UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

-- The bearer token is issued at verification, so an Account exists without one
-- between signup and the first verify.
ALTER TABLE users ALTER COLUMN api_token_sha256 DROP NOT NULL;

-- One pending login code per Account; requesting another replaces it. Stored
-- as a hash for the same reason the bearer token is.
ALTER TABLE users ADD COLUMN IF NOT EXISTS login_code_sha256 text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS login_code_expires_at timestamptz;
