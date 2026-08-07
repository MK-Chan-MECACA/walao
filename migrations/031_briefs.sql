-- The day's pick, cached. /v1/briefs/today is recomputed on every page load, so
-- an un-cached model call there would bill a refresh. input_hash fingerprints
-- exactly what the picker was shown: same inputs, serve the stored row; a new
-- Summary or a newly cleared item changes the hash and buys one call.
--
-- One row per Account per local day. delivered_at is the daily message's
-- idempotency key (ticket 06), so a restart mid-send cannot double-message.
CREATE TABLE IF NOT EXISTS briefs (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day          date NOT NULL,
  input_hash   text NOT NULL,
  headline     text NOT NULL,
  item_keys    text[] NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- When this row becomes eligible to send. A row written by the digest clock
  -- is due at the Account's digest time; one written by a pushing Group, or by
  -- the web path, is due immediately.
  due_at       timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  PRIMARY KEY (user_id, day)
);
