-- WALAO ticket 16: quality operations (spec §54-55). Weekly human review:
-- per-summary Malay reviews (kind 'malay', one row per reviewed summary) and
-- one weekly beta review (kind 'beta') recording accuracy/omission/privacy-event
-- counts. Reviewer is a name, not a users row — the quality owner is an
-- operator role, and the record must survive account deletion.

CREATE TABLE IF NOT EXISTS quality_reviews (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL CHECK (kind IN ('malay', 'beta')),
  summary_id uuid REFERENCES summaries(id) ON DELETE CASCADE,
  reviewer   text NOT NULL,
  verdict    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Malay reviews are per-summary; beta reviews are product-wide.
  CHECK ((kind = 'malay') = (summary_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS quality_reviews_summary_idx ON quality_reviews (summary_id);
