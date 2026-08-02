-- WALAO ticket 19: consent_records generalises into attestations (spec §205-210).
-- Every versioned affirmation an Account makes — the data-processing terms at
-- signup, ban risk at pairing, responsibility per Group, Tier 1 outbound —
-- lands in one table with the exact version of the wording that was shown.

DO $$
BEGIN
  IF to_regclass('public.attestations') IS NULL THEN
    ALTER TABLE consent_records RENAME TO attestations;
    ALTER TABLE attestations RENAME COLUMN action TO kind;
    ALTER TABLE attestations RENAME COLUMN attestation_version TO version;
  ELSE
    -- Migrations replay on every boot and 002 re-creates consent_records empty;
    -- drop that ghost rather than fail the rename.
    DROP TABLE IF EXISTS consent_records;
  END IF;
END $$;

-- Account-scoped kinds have no Group.
ALTER TABLE attestations ALTER COLUMN group_id DROP NOT NULL;

-- The old single-column check on action, and the two-column one Postgres named
-- consent_records_check (action = 'disabled' OR attestation_version IS NOT NULL).
ALTER TABLE attestations DROP CONSTRAINT IF EXISTS consent_records_action_check;
ALTER TABLE attestations DROP CONSTRAINT IF EXISTS consent_records_check;

UPDATE attestations SET kind = 'group_responsibility' WHERE kind = 'enabled';
UPDATE attestations SET kind = 'group_disabled' WHERE kind = 'disabled';

ALTER TABLE attestations DROP CONSTRAINT IF EXISTS attestations_kind_check;
ALTER TABLE attestations ADD CONSTRAINT attestations_kind_check CHECK (
  kind IN ('data_processing_terms', 'ban_risk', 'group_responsibility',
           'tier1_outbound', 'group_disabled')
);

-- Every kind but the disable audit row is an affirmation, so it carries a version.
ALTER TABLE attestations DROP CONSTRAINT IF EXISTS attestations_version_check;
ALTER TABLE attestations ADD CONSTRAINT attestations_version_check CHECK (
  kind = 'group_disabled' OR version IS NOT NULL
);

-- Group-scoped kinds have a Group; account-scoped ones do not.
ALTER TABLE attestations DROP CONSTRAINT IF EXISTS attestations_group_scope_check;
ALTER TABLE attestations ADD CONSTRAINT attestations_group_scope_check CHECK (
  (kind IN ('group_responsibility', 'group_disabled')) = (group_id IS NOT NULL)
);

-- Replaced by a tier1_outbound Attestation row; tier1_enabled_at stays as the
-- fast lookup the outbound path reads.
ALTER TABLE users DROP COLUMN IF EXISTS tier1_authorization_version;
