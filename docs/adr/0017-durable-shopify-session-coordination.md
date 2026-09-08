# ADR 0017: Durable Shopify session coordination

- Date: 2026-09-06
- Status: Accepted
- Stakeholders: Hiro (PO), Codex (implementation)

## Context

The isolated public-app runtime must renew expiring offline credentials without
letting concurrent requests, delayed invalidations, or workers from a previous
installation overwrite newer sessions. The current adapter rereads the persisted
token immediately before writing, after the provider operation has already run.
That is not an observation of the state on which the operation was based. The
SDK can also return a new Session object during refresh and mutate an existing
object during a later GraphQL 401; object-local tracking alone is insufficient.

The existing session table stores encrypted SDK payloads and can be absent before
installation or deleted during lifecycle cleanup. It is not a durable coordination
record. Redis lease renewal alone does not fence a delayed database write after a
worker loses ownership. Shopify's refresh-token recovery window does not remove
the requirement to serialize refreshes and atomically persist each returned pair.

## Decision

Use a dedicated Weletic-owned, app/shop-scoped coordination table with a durable
revision and an expiring, opaque lease owner. Keep access and refresh credentials
encrypted in the existing session payload; do not create another token authority.
Preserve the original session observation through the SDK operation, including
new Session instances and delayed invalidation/deletion. Database publication
must check lease ownership/expiry and the observed revision in its transaction.

Keep canonical shop identity, installation generation, uninstall freeze, and
privacy tombstones authoritative. Coordination is not reconnect authorization.
Provider requests must not hold open database transactions. Losing a lease or
receiving an ambiguous response fails closed; later recovery rereads authoritative
state. No in-memory singleton or generic Redis lock is the correctness boundary.

## Alternatives considered

- **Extend session rows into lock records** — rejected because coordination must
  exist before an SDK payload and survive its invalidation or deletion without
  changing the meaning of a loadable Shopify session.
- **Redis-only lease** — rejected because expiry or loss of ownership cannot
  prevent a stale database publisher without a durable database fence.
- **Only compare access-token hashes** — rejected because a late reread can
  bless a stale result, and token-less invalidation/deletion also needs fencing.

## Consequences

### Positive

- One durable owner/revision boundary for competing session mutations.
- Credentials remain encrypted and under the existing signed service boundary.
- MySQL-backed tests can exercise real transaction and stale-worker behavior.

### Negative / trade-offs accepted

- One additive table, extra coordination requests, and bounded contention.
- SDK integration must preserve observations across asynchronous callbacks.
- Coordination metadata needs lifecycle retention and privacy cleanup without
  reopening a stale-writer window.

### Follow-ups

- Validate the additive migration and races only in the isolated development
  database. Shared-schema PR merge requires explicit Hiro confirmation.
- Test overlapping renewal, lease expiry, invalidation/deletion, first-session
  creation, and uninstall/reinstall fencing through production boundaries.
- Complete scheduled renewal and reconnect alerts; prove installation and real
  provider round trips only after their separate activation approvals.
- Keep the benchmark store, retained database, and existing credentials intact.

## References

- Hiro's approval in this task on 2026-09-06: dedicated coordination table and
  isolated-database validation, with separate schema merge approval.
- [Unified completion plan](https://www.notion.so/3d2e26097bfd81c0a667ce21978d4fdc).
- [Shopify refresh-token recovery guidance](https://shopify.dev/changelog/more-resilient-refreshes-for-expiring-offline-access-tokens).
