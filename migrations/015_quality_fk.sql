-- Review fix for 014: quality records must survive summary/account deletion —
-- the whole reason reviewer is free text. CASCADE deleted them; SET NULL keeps
-- the row with summary_id nulled. Also enforce 014's stated one-review-per-
-- summary invariant with a partial unique index.

ALTER TABLE quality_reviews DROP CONSTRAINT IF EXISTS quality_reviews_summary_id_fkey;
ALTER TABLE quality_reviews ADD CONSTRAINT quality_reviews_summary_id_fkey
  FOREIGN KEY (summary_id) REFERENCES summaries(id) ON DELETE SET NULL;

-- 014's CHECK required malay ⇔ summary_id NOT NULL, which SET NULL would
-- violate. Beta reviews still never carry a summary; malay rows may lose
-- theirs after deletion (insert-time presence is enforced in recordReview).
ALTER TABLE quality_reviews DROP CONSTRAINT IF EXISTS quality_reviews_check;
ALTER TABLE quality_reviews DROP CONSTRAINT IF EXISTS quality_reviews_beta_no_summary_check;
ALTER TABLE quality_reviews ADD CONSTRAINT quality_reviews_beta_no_summary_check
  CHECK (kind <> 'beta' OR summary_id IS NULL);

CREATE UNIQUE INDEX IF NOT EXISTS quality_reviews_one_per_summary
  ON quality_reviews (summary_id) WHERE kind = 'malay';
