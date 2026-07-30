-- WALAO ticket 6: summaries with citation contract + per-summary metrics.
-- from_me marks the gateway's own system echoes so processing can exclude them
-- (spec §45) while the raw store still keeps the full record.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS from_me boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS summaries (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id       uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  job_id         bigint REFERENCES summary_jobs(id) ON DELETE SET NULL,
  language       text NOT NULL CHECK (language IN ('zh', 'en', 'ms')),
  window_start   timestamptz NOT NULL,
  window_end     timestamptz NOT NULL,
  -- The locked output contract (README §11), validated before storage: only the
  -- six known sections, every item carrying >=1 valid source-message reference.
  payload        jsonb NOT NULL,
  -- Per-summary metrics (spec §18): traceable quality and cost, no raw chat.
  model          text NOT NULL,
  prompt_version text NOT NULL,
  input_tokens   int NOT NULL,
  output_tokens  int NOT NULL,
  duration_ms    int NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS summaries_user_id_idx ON summaries (user_id);
