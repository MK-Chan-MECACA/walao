-- The gateway ships the sender's WhatsApp display name (push_name) on every
-- message event; WALAO threw it away and kept only the opaque sender_ref. With
-- LID addressing (30558843351102@lid) that ref is unreadable to both the user
-- and the summarizer, so an action item's owner could never be named.
--
-- This is Group Member personal data, so it lives on the message row: same
-- expires_at, same per-Account delete, same export. Nothing retains a name
-- longer than the message it came from.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_name text;
