-- WALAO ticket 21 (spec §21): an Attestation stores the exact wording shown,
-- not only its version. A version string alone is only provable while the
-- constant it names still holds the same words; the copy on the row survives
-- any later edit. Rows written before this migration keep a null text — they
-- predate the guarantee, and back-filling them from today's constants would
-- fabricate the very proof this column exists to provide.
ALTER TABLE attestations ADD COLUMN IF NOT EXISTS text text;
