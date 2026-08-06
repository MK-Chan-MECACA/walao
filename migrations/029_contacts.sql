-- WhatsApp writes an in-body mention as the bare id ("@40102864666870"), and
-- the person mentioned often never posts in a monitored Group — so no message
-- row ever carries their push_name and the id stays unreadable to both the user
-- and the summarizer. The session's own contact list is the only place those
-- names exist: GET /api/{session}/contacts returns them, LID-addressed included.
--
-- Names only, no numbers beyond the jid WALAO already stores on messages, and
-- the row hangs off the Session: unpairing or deleting the Account takes it
-- with them via the same cascade that takes the messages.
CREATE TABLE IF NOT EXISTS contacts (
  session_id uuid NOT NULL REFERENCES whatsapp_sessions(id) ON DELETE CASCADE,
  jid text NOT NULL,
  name text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, jid)
);
