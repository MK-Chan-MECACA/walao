-- The Account holder's own WhatsApp identity, read from the gateway when a
-- Session reaches 'connected'. Needed to answer "was I @mentioned in this
-- message?", which is a substring test against message bodies — the number hash
-- the Trial uses can only test equality, so it cannot answer it.
--
-- WhatsApp addresses one human two ways, a phone-based id and a LID, and a
-- sender's client writes the mention as the bare digits of whichever one it
-- holds. Both forms are stored or matching silently fails for half of senders.
-- The display name is stored for a different reason: an Item reads "Lee Yee
-- asked MK Chan whether the format is OK", and only the name tells a downstream
-- judgement that the line is addressed to this Account.
--
-- Not a new class of data: the raw identity of every OTHER member of every
-- enabled Group is already stored on messages and in contacts. All three are
-- nullable — a gateway that cannot name the Session leaves them empty and
-- everything else in the product carries on.
ALTER TABLE whatsapp_sessions
  ADD COLUMN IF NOT EXISTS self_phone text,
  ADD COLUMN IF NOT EXISTS self_lid text,
  ADD COLUMN IF NOT EXISTS self_name text;
