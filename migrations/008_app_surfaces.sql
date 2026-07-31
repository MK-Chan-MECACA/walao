-- WALAO ticket 9: app surfaces — per-item complete/dismiss state and confirmed
-- reminders. A reminder row exists only after explicit user confirmation, so an
-- unconfirmed extracted action item can never fire (spec: group text alone
-- never triggers anything).

CREATE TABLE IF NOT EXISTS item_states (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  summary_id uuid NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
  section    text NOT NULL,
  item_index int  NOT NULL CHECK (item_index >= 0),
  state      text NOT NULL CHECK (state IN ('complete', 'dismissed')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, summary_id, section, item_index)
);

-- text/owner/due_at are copied at confirmation time and summary_id is SET NULL
-- on purge, so a confirmed reminder outlives its ~90-day source summary.
CREATE TABLE IF NOT EXISTS reminders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  summary_id   uuid REFERENCES summaries(id) ON DELETE SET NULL,
  item_index   int  NOT NULL CHECK (item_index >= 0),
  text         text NOT NULL,
  owner        text,
  due_at       timestamptz,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'dismissed')),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, summary_id, item_index)
);

CREATE INDEX IF NOT EXISTS reminders_user_id_idx ON reminders (user_id);
