-- WALAO ticket 25: the 14-day Trial (spec §96-99, §229-234). Pro's caps from the
-- moment pairing completes, no card, falling back to Free when it ends.
--
-- The grant is once per WhatsApp number rather than once per Account, so the
-- offer is honest and not farmable by re-signup: only the number's hash is
-- stored, and user_id is SET NULL rather than cascaded so the grant outlives the
-- Account that used it. What remains is a hash and two timestamps — no message,
-- no email, nothing that identifies the deleted Account.

CREATE TABLE IF NOT EXISTS trials (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  number_sha256 text NOT NULL UNIQUE,
  started_at    timestamptz NOT NULL DEFAULT now(),
  ends_at       timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS trials_user_id_idx ON trials (user_id);
