-- WALAO ticket 5: per-group summary schedules stored as local time + timezone
-- (never UTC-only, so the fire time tracks DST shifts), plus the emitted jobs.

CREATE TABLE IF NOT EXISTS summary_schedules (
  group_id      uuid PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  local_time    text NOT NULL,  -- 'HH:MM' wall clock in the group's timezone
  timezone      text NOT NULL,  -- IANA zone name, validated at the API boundary
  language      text NOT NULL CHECK (language IN ('zh', 'en', 'ms')),
  last_fired_at timestamptz,    -- instant the last window closed (job or quiet no-op)
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS summary_jobs (
  id           bigserial PRIMARY KEY,
  group_id     uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  language     text NOT NULL,
  window_start timestamptz NOT NULL,
  window_end   timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'pending',
  created_at   timestamptz NOT NULL DEFAULT now()
);
