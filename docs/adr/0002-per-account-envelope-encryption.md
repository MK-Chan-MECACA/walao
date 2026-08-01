# Message bodies are encrypted with a per-Account key, wrapped by the master key

WALAO promises that deletion propagates to primary storage, caches, indexes and
controllable backups, but a nightly Postgres backup cannot be rewritten. Each
Account therefore gets a random data key, stored on its `users` row encrypted
with `WALAO_ENC_KEY`; message bodies are encrypted with the Account's key, not
the master key. Deleting an Account deletes its key, which makes that Account's
rows undecryptable everywhere they still exist — the only honest way to keep the
promise once WALAO holds many merchants' data.

## Consequences

- Master-key rotation rewraps N key rows instead of re-encrypting every message
  row.
- A DB dump plus the master key no longer exposes deleted Accounts, only live
  ones.
- Every read path must unwrap the Account key first; cache it per request rather
  than per row.
- Crypto-shredding is now the deletion mechanism of record, so any future
  feature that copies plaintext out of `messages` (a search index, an export
  cache, a log line) silently breaks the guarantee.
