-- WALAO ticket 24 (spec §71-72, §220-227, ADR-0002): per-Account envelope
-- encryption. Message bodies stop being encrypted with the master key and start
-- being encrypted with a random 32-byte key that belongs to one Account, stored
-- here wrapped under WALAO_ENC_KEY. Deleting the Account deletes the key, which
-- is what makes its rows undecryptable in a backup nobody can rewrite.
-- Rows written before this migration were encrypted under the master key and do
-- not decrypt under an Account key. No backfill: raw messages expire within 30
-- days by design, and this is dev-scale data only.
ALTER TABLE users ADD COLUMN IF NOT EXISTS data_key_wrapped bytea;
