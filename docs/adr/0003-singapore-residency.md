# Production runs in Singapore (ap-southeast-1), with AI calls disclosed as offshore

Merchants are Malaysian and their data is governed by the PDPA, whose 2024
amendment replaced the old country whitelist with an adequacy-and-safeguards
test, making regional hosting workable. We run the app, Postgres and the gateway
in ap-southeast-1 — roughly 5ms from Kuala Lumpur, with mature managed Postgres,
backups and monitoring — rather than onshore Malaysian infrastructure, and
disclose the region in the privacy policy.

## Consequences

- Summarisation sends message text to Anthropic outside the region regardless of
  where Postgres sits, so a "your data never leaves Malaysia" claim was never
  available. One clearly disclosed story beats a claim needing a caveat.
- Safeguards carrying the PDPA transfer basis are the ones already decided:
  per-Account encryption at rest (ADR-0002), no Operator access to message or
  summary bodies, and no use of merchant data for model training.
- Moving regions later means downtime, a data migration, and re-disclosure. This
  is the least reversible infrastructure decision in the system.
