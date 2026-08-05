-- WALAO F4: abuse control for the three unauthenticated routes.
-- One row per (what is being limited, who is doing it) — a fixed window, not a
-- sliding one, because the point is to stop a mail bomb, not to meter fairly.
-- Postgres rather than process memory so the limit survives a restart and holds
-- across replicas; the volume is tiny and the rows are purged with the rest.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket text PRIMARY KEY,
  count integer NOT NULL DEFAULT 0,
  window_start timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rate_limits_window_start_idx ON rate_limits (window_start);
