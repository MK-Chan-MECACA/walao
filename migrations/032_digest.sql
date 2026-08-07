-- Ticket 06: the Account holder chooses when the one daily message arrives.
-- Local wall clock + IANA zone, never UTC, so the hour tracks DST exactly like
-- the per-Group schedules in 005 already do. An Account that never opens
-- Settings keeps the default and still gets its message.
ALTER TABLE users ADD COLUMN IF NOT EXISTS digest_time text NOT NULL DEFAULT '08:00';
ALTER TABLE users ADD COLUMN IF NOT EXISTS digest_timezone text NOT NULL DEFAULT 'Asia/Kuala_Lumpur';
