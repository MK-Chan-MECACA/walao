# One shared gateway process hosts every Account's WhatsApp Session

WALAO-as-SaaS needs one live WhatsApp connection per Account, and the official
WhatsApp Cloud API cannot read arbitrary groups a person belongs to, so an
unofficial gateway is mandatory. We run a single WAAPI gateway process holding
one named session per Account rather than a process per Account, because the
adapter already creates and namespaces sessions (`POST /api/sessions {name}`,
then `/api/{session}/...`) and the single `waapiBaseUrl` in config stays correct
with no routing table, orchestrator, or provisioning code.

## Consequences

- Blast radius is every Account: one process crash or one machine loss takes
  all merchants offline simultaneously.
- One SQLite file (`storages/gateway.db`) holds every merchant's WhatsApp
  credentials. Protect it as the single highest-value asset in the system.
- Live sessions are bounded by one process's memory and by WhatsApp's view of
  many accounts behind one IP. Idle sessions are therefore evicted after 14 days
  with no enabled Group or no login, flipping them to `re_pair_required`.
- The upgrade path when this ceiling is hit is sharded pools plus a
  `gateway_nodes` routing table. Nothing above `src/gateway/port.ts` needs to
  change when that happens.
