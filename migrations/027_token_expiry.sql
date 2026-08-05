-- WALAO F7: bearer tokens get an absolute TTL.
-- One non-expiring token per Account meant a leaked token worked until someone
-- thought to log out. Verifying mints a fresh 30-day token every time, so
-- signing in again is the renewal — there is nothing new for a client to call.
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_expires_at timestamptz;

-- Tokens minted before this column existed get the same 30 days rather than
-- being grandfathered forever (a token with no deadline is the bug) or killed
-- on deploy (which would sign everyone out to fix a latent risk). The WHERE
-- makes a re-run a no-op, so the migration stays idempotent like the rest.
UPDATE users
SET token_expires_at = now() + interval '30 days'
WHERE api_token_sha256 IS NOT NULL AND token_expires_at IS NULL;
